package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"
	"google.golang.org/grpc"

	"broker/internal/auth"
	"broker/internal/config"
	"broker/internal/hub"
	"broker/internal/redisx"
	"broker/internal/server"
)

func main() {
	genKeys := flag.String("gen-keys", "", "generate Ed25519 JWT keypair into directory and exit")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	if *genKeys != "" {
		if err := generateKeyPair(*genKeys); err != nil {
			slog.Error("gen-keys failed", "err", err)
			os.Exit(1)
		}
		return
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(1)
	}

	// Redis bus (optional in development; required in production).
	var bus *redisx.Bus
	var revoker auth.Revoker
	h := hub.New(cfg.Limits.MaxSubsPerConn)
	if cfg.Redis.Enabled {
		bus = redisx.New(cfg.Redis, cfg.NodeID, h, slog.Default())
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := bus.Ping(ctx); err != nil {
			cancel()
			slog.Error("redis unreachable", "err", err)
			os.Exit(1)
		}
		cancel()
		revoker = bus
	}

	validator, err := auth.NewValidator(cfg.Auth.Issuer, cfg.Auth.Audience, cfg.Auth.PublicKeysDir, revoker)
	if err != nil {
		slog.Error("auth validator failed", "err", err)
		os.Exit(1)
	}

	var busIface server.Bus
	if bus != nil {
		busIface = bus
		bus.Start(context.Background())
	}

	srv := server.New(cfg, h, validator, busIface, slog.Default())

	// Internal gRPC (backends). Bound to loopback by default: not public.
	grpcAddr := os.Getenv("BROKER_GRPC_ADDR")
	if grpcAddr == "" {
		grpcAddr = "127.0.0.1:9090"
	}
	grpcServer := grpc.NewServer()
	registerGRPC(grpcServer, srv)

	mux := srv.Handler()
	var httpSrv *http.Server

	useTLS := cfg.Env == config.EnvProduction && cfg.ACME.Enabled
	if useTLS {
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			Email:      cfg.ACME.Email,
			HostPolicy: autocert.HostWhitelist(cfg.ACME.Domain),
			Cache:      autocert.DirCache(cfg.ACME.CacheDir),
		}
		httpSrv = &http.Server{
			Addr:              cfg.ListenAddr,
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       cfg.Limits.ReadTimeout,
			WriteTimeout:      cfg.Limits.WriteTimeout,
			TLSConfig:         m.TLSConfig(),
		}
	} else {
		httpSrv = &http.Server{
			Addr:              cfg.ListenAddr,
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       cfg.Limits.ReadTimeout,
			WriteTimeout:      cfg.Limits.WriteTimeout,
		}
	}

	slog.Info("broker starting",
		"node_id", cfg.NodeID,
		"env", cfg.Env,
		"listen", cfg.ListenAddr,
		"grpc", grpcAddr,
		"tls", useTLS,
		"domain", cfg.ACME.Domain,
		"redis", cfg.Redis.Enabled,
		"max_conns", cfg.Limits.MaxConns,
	)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		lis, err := net.Listen("tcp", grpcAddr)
		if err != nil {
			slog.Error("grpc listen failed", "err", err)
			return
		}
		slog.Info("grpc listening", "addr", grpcAddr)
		if err := grpcServer.Serve(lis); err != nil {
			slog.Error("grpc serve ended", "err", err)
		}
	}()

	go func() {
		<-ctx.Done()
		slog.Info("shutting down")
		srv.Close()
		grpcServer.GracefulStop()
		if bus != nil {
			bus.Close()
		}
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	}()

	var serveErr error
	if useTLS {
		serveErr = httpSrv.ListenAndServeTLS("", "")
	} else {
		serveErr = httpSrv.ListenAndServe()
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		slog.Error("server failed", "err", serveErr)
		os.Exit(1)
	}
	slog.Info("stopped", "hub_clients", h.ClientCount())
}

// generateKeyPair writes <kid>.pub (broker) and <kid>.pem (backend signer), 0600.
func generateKeyPair(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return err
	}
	kid := fmt.Sprintf("k%d", time.Now().Unix())

	pubPEM, err := auth.EncodeEd25519PublicPEM(pub)
	if err != nil {
		return err
	}
	pubPath := filepath.Join(dir, kid+".pub")
	if err := os.WriteFile(pubPath, pubPEM, 0o644); err != nil {
		return err
	}

	privDER, err := auth.EncodeEd25519PrivatePEM(priv)
	if err != nil {
		return err
	}
	privPath := filepath.Join(dir, kid+".pem")
	if err := os.WriteFile(privPath, privDER, 0o600); err != nil {
		return err
	}
	fmt.Printf("kid=%s\npublic=%s\nprivate=%s\n", kid, pubPath, privPath)
	fmt.Println("Put the .pub in BROKER_JWT_PUBLIC_KEYS_DIR and keep the .pem only on your backend.")
	return nil
}
