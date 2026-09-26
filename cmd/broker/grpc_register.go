package main

import (
	"google.golang.org/grpc"

	"broker/internal/server"
	brokerv1 "broker/proto/gen/broker/v1"
)

// registerGRPC wires BrokerService on the internal gRPC server.
func registerGRPC(s *grpc.Server, srv *server.Server) {
	brokerv1.RegisterBrokerServiceServer(s, server.NewGRPCService(srv))
}
