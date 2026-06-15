package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sort"
	"testing"
)

func TestWalkDigestsOrderedAndSkipsTmp(t *testing.T) {
	ctx := context.Background()
	s, err := NewFSStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	want := make([]string, 0, 5)
	for i := range 5 {
		d, _, err := s.Put(ctx, bytes.NewReader(fmt.Appendf(nil, "walk-%d", i)))
		if err != nil {
			t.Fatal(err)
		}
		want = append(want, d)
	}
	sort.Strings(want)

	var got []string
	if err := s.WalkDigests(ctx, func(d string) error {
		got = append(got, d)
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("got %d digests, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order mismatch at %d: got %v want %v", i, got, want)
		}
	}
}

func TestWalkDigestsStopsOnCallbackError(t *testing.T) {
	ctx := context.Background()
	s, err := NewFSStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for i := range 3 {
		if _, _, err := s.Put(ctx, bytes.NewReader(fmt.Appendf(nil, "stop-%d", i))); err != nil {
			t.Fatal(err)
		}
	}
	stop := errors.New("stop")
	calls := 0
	err = s.WalkDigests(ctx, func(string) error {
		calls++
		return stop
	})
	if !errors.Is(err, stop) || calls != 1 {
		t.Fatalf("err = %v, calls = %d", err, calls)
	}
}

func TestWalkDigestsEmptyStore(t *testing.T) {
	s, err := NewFSStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.WalkDigests(context.Background(), func(string) error {
		t.Fatal("unexpected digest in empty store")
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
}
