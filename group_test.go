package flow

import (
	"context"
	"testing"

	"github.com/eadwinCode/flow-sdk/group"
	"github.com/eadwinCode/flow-sdk/step"
)

func TestNestedParallel(t *testing.T) {
	c := newClient(t, ClientOpts{})
	define(t, c, "fn", func(ctx context.Context, in Input[charge]) (any, error) {
		one := func(id string) func(context.Context) (any, error) {
			return func(ctx context.Context) (any, error) {
				return step.Run(ctx, id, func(ctx context.Context) (string, error) { return id, nil })
			}
		}
		group.Parallel(ctx, one("a"), func(ctx context.Context) (any, error) {
			return group.Parallel(ctx, one("b"), one("c")), nil
		})
		return "done", nil
	})
	ops := run(t, c, "fn", reqOpts{}).ops(t)
	if len(ops) != 3 || ops[0]["id"] != h("a", 0) || ops[1]["id"] != h("b", 0) || ops[2]["id"] != h("c", 0) {
		t.Fatalf("ops = %v", ops)
	}
	for _, op := range ops {
		if op["op"] != "StepPlanned" {
			t.Fatalf("ops = %v", ops)
		}
	}
	memo := map[string]any{h("a", 0): data("a"), h("b", 0): data("b"), h("c", 0): data("c")}
	if a := run(t, c, "fn", reqOpts{memo: memo}); a.status != 200 || string(a.body) != `"done"` {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestParallelOutsideFunction(t *testing.T) {
	res := group.Parallel(context.Background(), func(ctx context.Context) (any, error) { return 1, nil })
	if len(res) != 1 || res[0].Value != 1 {
		t.Fatalf("res = %v", res)
	}
	if _, err := step.Run(context.Background(), "x", func(ctx context.Context) (int, error) { return 1, nil }); err != step.ErrNotInFunction {
		t.Fatalf("err = %v", err)
	}
}
