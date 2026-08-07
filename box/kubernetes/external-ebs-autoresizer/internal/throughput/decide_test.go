package throughput

import (
	"math"
	"testing"
)

// baseSettings are the defaults the config ships, so a case that overrides
// nothing exercises the shipped policy.
func baseSettings() Settings {
	return Settings{
		HeadroomPercent:    30,
		StepMiBps:          125,
		MinThroughputMiBps: 125,
		MaxThroughputMiBps: 1000,
		MinSamples:         1000,
	}
}

func TestDecide(t *testing.T) {
	// m5.large: 81.25 MB/s baseline, 593.75 MB/s burst. Used to check that the
	// instance ceiling, not just the gp3 ceiling, clamps a recommendation.
	const m5LargeMaxMBps = 593.75

	tests := []struct {
		name       string
		in         Input
		mutate     func(*Settings)
		wantAction string
		wantReason string
		wantMiBps  int32
		wantIOPS   int32
		wantCapped bool
	}{
		{
			name: "peak plus headroom above provisioned recommends an increase",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: 200, Samples: 5000,
			},
			wantAction: ActionIncrease, wantReason: ReasonAboveProvisioned,
			// 200 * 1.3 = 260, rounded up to the next 125 step.
			wantMiBps: 375, wantIOPS: 3000,
		},
		{
			name: "peak within provisioned recommends nothing",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: 90, Samples: 5000,
			},
			wantAction: ActionNone, wantReason: ReasonFits,
			// A no-change decision reports the current provisioning, not the
			// computed target, so the annotation never reads as a pending change.
			wantMiBps: 125, wantIOPS: 3000,
		},
		{
			name: "a full step of slack recommends a decrease",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 500, CurrentIOPS: 3000,
				PeakMiBps: 10, Samples: 5000,
			},
			wantAction: ActionDecrease, wantReason: ReasonBelowProvisioned,
			wantMiBps: 125, wantIOPS: 3000,
		},
		{
			name: "less than a full step of slack does not decrease, so a recommendation cannot flap",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 250, CurrentIOPS: 3000,
				PeakMiBps: 100, Samples: 5000,
			},
			wantAction: ActionNone, wantReason: ReasonFits,
			wantMiBps: 250, wantIOPS: 3000,
		},
		{
			name: "throughput above 750 forces an IOPS bump to satisfy the gp3 ratio",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: 700, Samples: 5000,
			},
			wantAction: ActionIncrease, wantReason: ReasonAboveProvisioned,
			// 700 * 1.3 = 910 -> 1000 MiB/s, which needs 4000 IOPS at the 0.25
			// MiB/s-per-IOPS limit; the default 3000 IOPS would cap it at 750.
			wantMiBps: 1000, wantIOPS: 4000,
		},
		{
			name: "IOPS is never recommended downward",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 9000,
				PeakMiBps: 200, Samples: 5000,
			},
			wantAction: ActionIncrease, wantReason: ReasonAboveProvisioned,
			wantMiBps: 375, wantIOPS: 9000,
		},
		{
			name: "demand beyond the gp3 maximum is clamped and reported as capped",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 500, CurrentIOPS: 4000,
				PeakMiBps: 2000, Samples: 5000,
			},
			wantAction: ActionIncrease, wantReason: ReasonVolumeMaxCap,
			wantMiBps: 1000, wantIOPS: 4000, wantCapped: true,
		},
		{
			name: "the instance bandwidth ceiling clamps below the gp3 maximum",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: 2000, Samples: 5000,
				InstanceMaxMiBps: MBpsToMiBps(m5LargeMaxMBps),
			},
			wantAction: ActionIncrease, wantReason: ReasonInstanceBandwidthCap,
			// 593.75 MB/s is 566 MiB/s: recommending 594 would ask for throughput
			// the instance cannot drive.
			wantMiBps: 566, wantIOPS: 3000, wantCapped: true,
		},
		{
			name: "a volume already at the ceiling stays visibly capped with no action",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 1000, CurrentIOPS: 4000,
				PeakMiBps: 2000, Samples: 5000,
			},
			wantAction: ActionNone, wantReason: ReasonVolumeMaxCap,
			wantMiBps: 1000, wantIOPS: 4000, wantCapped: true,
		},
		{
			name: "the configured maximum clamps below the gp3 maximum",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: 900, Samples: 5000,
			},
			mutate:     func(s *Settings) { s.MaxThroughputMiBps = 500 },
			wantAction: ActionIncrease, wantReason: ReasonVolumeMaxCap,
			wantMiBps: 500, wantIOPS: 3000, wantCapped: true,
		},
		{
			name: "a near-idle volume never drops below the floor",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: 0, Samples: 5000,
			},
			wantAction: ActionNone, wantReason: ReasonFits,
			wantMiBps: 125, wantIOPS: 3000,
		},
		{
			name: "a raised floor recommends an increase on an idle volume",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: 5, Samples: 5000,
			},
			mutate:     func(s *Settings) { s.MinThroughputMiBps = 250 },
			wantAction: ActionIncrease, wantReason: ReasonAboveProvisioned,
			wantMiBps: 250, wantIOPS: 3000,
		},
		{
			name: "too few samples yields no recommendation",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: 900, Samples: 12,
			},
			wantAction: ActionUnknown, wantReason: ReasonInsufficientData,
		},
		{
			name: "a non-gp3 volume is out of scope",
			in: Input{
				VolumeType: "gp2", CurrentThroughputMiBps: 0, CurrentIOPS: 3000,
				PeakMiBps: 900, Samples: 5000,
			},
			wantAction: ActionUnknown, wantReason: ReasonUnsupportedVolumeType,
		},
		{
			name: "a NaN peak is missing data, not idleness",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 500, CurrentIOPS: 3000,
				PeakMiBps: math.NaN(), Samples: 5000,
			},
			wantAction: ActionUnknown, wantReason: ReasonInsufficientData,
		},
		{
			name: "an infinite peak is rejected rather than clamped to the ceiling",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: math.Inf(1), Samples: 5000,
			},
			wantAction: ActionUnknown, wantReason: ReasonInsufficientData,
		},
		{
			name: "a negative peak is rejected",
			in: Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: 125, CurrentIOPS: 3000,
				PeakMiBps: -1, Samples: 5000,
			},
			wantAction: ActionUnknown, wantReason: ReasonInsufficientData,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := baseSettings()
			if tt.mutate != nil {
				tt.mutate(&s)
			}
			got := Decide(tt.in, s)
			if got.Action != tt.wantAction {
				t.Errorf("action = %q, want %q", got.Action, tt.wantAction)
			}
			if got.Reason != tt.wantReason {
				t.Errorf("reason = %q, want %q", got.Reason, tt.wantReason)
			}
			if got.RecommendedThroughputMiBps != tt.wantMiBps {
				t.Errorf("recommended throughput = %d, want %d", got.RecommendedThroughputMiBps, tt.wantMiBps)
			}
			if got.RecommendedIOPS != tt.wantIOPS {
				t.Errorf("recommended IOPS = %d, want %d", got.RecommendedIOPS, tt.wantIOPS)
			}
			if got.Capped != tt.wantCapped {
				t.Errorf("capped = %v, want %v", got.Capped, tt.wantCapped)
			}
		})
	}
}

// TestDecideRecommendationIsAlwaysProvisionable guards the invariant that makes a
// recommendation safe to apply: it must be within the gp3 range, and its IOPS
// must satisfy the 0.25 MiB/s-per-IOPS ratio. A recommendation that violates
// either is rejected by EC2 at apply time, which is exactly the failure an
// operator cannot debug from an annotation.
func TestDecideRecommendationIsAlwaysProvisionable(t *testing.T) {
	s := baseSettings()
	// Each pair is a volume AWS would actually accept: its IOPS already satisfies
	// the ratio for its throughput. An impossible starting volume (1000 MiB/s on
	// 3000 IOPS) cannot exist, so feeding one in would test nothing real.
	currents := []struct{ throughput, iops int32 }{
		{throughput: 125, iops: 3000},
		{throughput: 250, iops: 3000},
		{throughput: 750, iops: 3000},
		{throughput: 1000, iops: 4000},
	}
	for peak := 0; peak <= 3000; peak += 7 {
		for _, current := range currents {
			d := Decide(Input{
				VolumeType: VolumeTypeGP3, CurrentThroughputMiBps: current.throughput, CurrentIOPS: current.iops,
				PeakMiBps: float64(peak), Samples: 5000,
			}, s)
			if d.Action == ActionUnknown {
				t.Fatalf("peak %d current %d: unexpected unknown (%s)", peak, current.throughput, d.Reason)
			}
			if d.RecommendedThroughputMiBps < gp3MinThroughputMiBps || d.RecommendedThroughputMiBps > gp3MaxThroughputMiBps {
				t.Fatalf("peak %d current %d: throughput %d outside the gp3 range", peak, current.throughput, d.RecommendedThroughputMiBps)
			}
			if d.RecommendedIOPS < d.RecommendedThroughputMiBps*gp3IOPSPerMiBps {
				t.Fatalf("peak %d current %d: %d IOPS cannot sustain %d MiB/s",
					peak, current.throughput, d.RecommendedIOPS, d.RecommendedThroughputMiBps)
			}
			if d.RecommendedIOPS < gp3MinIOPS || d.RecommendedIOPS > gp3MaxIOPS {
				t.Fatalf("peak %d current %d: IOPS %d outside the gp3 range", peak, current.throughput, d.RecommendedIOPS)
			}
		}
	}
}

func TestMBpsToMiBps(t *testing.T) {
	// 593.75 MB/s is the m5.large burst figure AWS publishes; treating it as MiB/s
	// would overstate the instance's headroom by about 4.9%.
	got := MBpsToMiBps(593.75)
	if math.Abs(got-566.24) > 0.01 {
		t.Errorf("MBpsToMiBps(593.75) = %v, want about 566.24", got)
	}
	if MBpsToMiBps(0) != 0 {
		t.Errorf("MBpsToMiBps(0) = %v, want 0", MBpsToMiBps(0))
	}
}

func TestCeilToStep(t *testing.T) {
	tests := []struct {
		v    float64
		step int32
		want int32
	}{
		{v: 1, step: 125, want: 125},
		{v: 125, step: 125, want: 125},
		{v: 126, step: 125, want: 250},
		{v: 0, step: 125, want: 0},
		// A non-positive step disables quantization rather than dividing by zero.
		{v: 130.2, step: 0, want: 131},
		{v: 130.2, step: -1, want: 131},
	}
	for _, tt := range tests {
		if got := ceilToStep(tt.v, tt.step); got != tt.want {
			t.Errorf("ceilToStep(%v, %d) = %d, want %d", tt.v, tt.step, got, tt.want)
		}
	}
}

func TestBoundsCollapsesAMisconfiguredRange(t *testing.T) {
	// A floor above every ceiling must not produce a recommendation EBS would
	// reject; it collapses onto the ceiling instead.
	floor, ceiling, reason := bounds(Settings{MinThroughputMiBps: 900, MaxThroughputMiBps: 1000}, MBpsToMiBps(200))
	if floor != ceiling {
		t.Errorf("floor = %d, ceiling = %d, want them equal", floor, ceiling)
	}
	if reason != ReasonInstanceBandwidthCap {
		t.Errorf("reason = %q, want %q", reason, ReasonInstanceBandwidthCap)
	}
}
