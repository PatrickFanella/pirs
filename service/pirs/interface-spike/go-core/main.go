package main

import (
	"encoding/json"
	"unsafe"
)

var input [4096]byte

//go:wasmimport pirs emit
func emit(ptr, length uint32) uint32

//go:wasmexport input_ptr
func inputPtr() uint32 { return uint32(uintptr(unsafe.Pointer(&input[0]))) }

//go:wasmexport on_event
func onEvent(ptr, length uint32) uint32 {
	if ptr != inputPtr() || length > uint32(len(input)) {
		panic("input bounds")
	}
	var event struct {
		Seq     uint32 `json:"seq"`
		Payload string `json:"payload"`
	}
	if err := json.Unmarshal(input[:length], &event); err != nil {
		panic(err)
	}
	if event.Seq != 42 || len(event.Payload) != 64 {
		panic("event mismatch")
	}
	return emit(ptr, length)
}

func main() {}
