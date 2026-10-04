package export_wit_world

import "wit_component/pirs_spike_host"

func OnEvent(value pirs_spike_host.Event) uint32 {
	if value.Seq != 42 || len(value.Payload) != 64 {
		panic("event mismatch")
	}
	return pirs_spike_host.Emit(value)
}
