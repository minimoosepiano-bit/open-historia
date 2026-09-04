/*! Open Historia — real-time clock core tests © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
// Run: node --test src/runtime/realtimeCore.test.js

import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_SPEED_ID,
    REALTIME_SPEEDS,
    advancePending,
    clockPlan,
    displayDayOffset,
    nextSlice,
    nextSpeedId,
    speedById,
    tickProgress,
} from "./realtimeCore.js";

// ---- Group S: speed table ---------------------------------------------------

test("S1 every speed step is faster than the one before it", () => {
    for (let i = 1; i < REALTIME_SPEEDS.length; i += 1) {
        assert.ok(REALTIME_SPEEDS[i].secondsPerDay < REALTIME_SPEEDS[i - 1].secondsPerDay);
    }
});
test("S2 speedById resolves a known id", () => {
    assert.equal(speedById(3).id, 3);
});
test("S3 speedById falls back to the default for junk", () => {
    assert.equal(speedById("nope").id, DEFAULT_SPEED_ID);
    assert.equal(speedById(undefined).id, DEFAULT_SPEED_ID);
});
test("S4 nextSpeedId cycles and wraps", () => {
    assert.equal(nextSpeedId(1), 2);
    assert.equal(nextSpeedId(REALTIME_SPEEDS[REALTIME_SPEEDS.length - 1].id), REALTIME_SPEEDS[0].id);
});
test("S5 nextSpeedId on an unknown id starts the cycle over", () => {
    assert.equal(nextSpeedId(99), REALTIME_SPEEDS[0].id);
});

// ---- Group P: clockPlan -----------------------------------------------------

test("P1 a tick covers at least one whole day at every speed", () => {
    for (const speed of REALTIME_SPEEDS) {
        assert.ok(clockPlan(speed.id).tickDays >= 1);
    }
});
test("P2 faster speeds cover more days per tick", () => {
    const spans = REALTIME_SPEEDS.map((speed) => clockPlan(speed.id).tickDays);
    for (let i = 1; i < spans.length; i += 1) {
        assert.ok(spans[i] > spans[i - 1]);
    }
});
test("P3 a tick lands on roughly the same real-time cadence at every speed", () => {
    for (const speed of REALTIME_SPEEDS) {
        const plan = clockPlan(speed.id);
        const seconds = plan.tickDays * plan.secondsPerDay;
        assert.ok(seconds >= 20 && seconds <= 45, `${speed.name}: ${seconds}s per tick`);
    }
});
test("P4 a slice may cover more than one tick, and the backlog cap leaves room for one", () => {
    const plan = clockPlan(DEFAULT_SPEED_ID);
    assert.ok(plan.maxSliceDays >= plan.tickDays);
    assert.ok(plan.maxPendingDays >= plan.tickDays);
});

// ---- Group A: advancePending ------------------------------------------------

test("A1 elapsed time becomes game days at the speed's rate", () => {
    const { pendingDays } = advancePending({ pendingDays: 0, elapsedMs: 8000, secondsPerDay: 4, maxPendingDays: 100 });
    assert.equal(pendingDays, 2);
});
test("A2 backlog accumulates across calls", () => {
    let pending = 0;
    for (let i = 0; i < 4; i += 1) {
        ({ pendingDays: pending } = advancePending({ pendingDays: pending, elapsedMs: 1000, secondsPerDay: 4, maxPendingDays: 100 }));
    }
    assert.equal(pending, 1);
});
test("A3 the cap clips the backlog and reports the stall", () => {
    const result = advancePending({ pendingDays: 15, elapsedMs: 60000, secondsPerDay: 4, maxPendingDays: 16 });
    assert.equal(result.pendingDays, 16);
    assert.equal(result.stalled, true);
});
test("A4 staying under the cap is not a stall", () => {
    const result = advancePending({ pendingDays: 1, elapsedMs: 4000, secondsPerDay: 4, maxPendingDays: 16 });
    assert.equal(result.pendingDays, 2);
    assert.equal(result.stalled, false);
});
test("A5 landing exactly on the cap is not a stall", () => {
    const result = advancePending({ pendingDays: 12, elapsedMs: 16000, secondsPerDay: 4, maxPendingDays: 16 });
    assert.equal(result.pendingDays, 16);
    assert.equal(result.stalled, false);
});
test("A6 negative or junk elapsed time never rewinds the clock", () => {
    assert.equal(advancePending({ pendingDays: 3, elapsedMs: -5000, secondsPerDay: 4, maxPendingDays: 16 }).pendingDays, 3);
    assert.equal(advancePending({ pendingDays: 3, elapsedMs: NaN, secondsPerDay: 4, maxPendingDays: 16 }).pendingDays, 3);
});

// ---- Group N: nextSlice -----------------------------------------------------

test("N1 no slice until a whole tick has accrued", () => {
    assert.equal(nextSlice({ pendingDays: 7.4, tickDays: 8, maxSliceDays: 16 }), 0);
});
test("N2 a full tick dispatches exactly its whole days", () => {
    assert.equal(nextSlice({ pendingDays: 8.6, tickDays: 8, maxSliceDays: 16 }), 8);
});
test("N3 a backlog dispatches every whole day it has", () => {
    assert.equal(nextSlice({ pendingDays: 13.2, tickDays: 8, maxSliceDays: 16 }), 13);
});
test("N4 a slice never exceeds maxSliceDays", () => {
    assert.equal(nextSlice({ pendingDays: 400, tickDays: 8, maxSliceDays: 16 }), 16);
});
test("N5 float slack still counts as a full tick", () => {
    assert.equal(nextSlice({ pendingDays: 7.9999999999, tickDays: 8, maxSliceDays: 16 }), 8);
});
test("N6 a forced slice fires below the tick threshold", () => {
    assert.equal(nextSlice({ pendingDays: 0.3, tickDays: 8, maxSliceDays: 16, force: true }), 1);
});
test("N7 a forced slice is never zero days, even on an empty backlog", () => {
    assert.equal(nextSlice({ pendingDays: 0, tickDays: 8, maxSliceDays: 16, force: true }), 1);
});
test("N8 a forced slice still honours maxSliceDays", () => {
    assert.equal(nextSlice({ pendingDays: 90, tickDays: 8, maxSliceDays: 16, force: true }), 16);
});
test("N9 a forced slice spends the whole backlog it has", () => {
    assert.equal(nextSlice({ pendingDays: 11.7, tickDays: 8, maxSliceDays: 16, force: true }), 11);
});

// ---- Group D: display helpers ----------------------------------------------

test("D1 tickProgress fills from empty to full across one tick", () => {
    assert.equal(tickProgress({ pendingDays: 0, tickDays: 8 }), 0);
    assert.equal(tickProgress({ pendingDays: 4, tickDays: 8 }), 0.5);
    assert.equal(tickProgress({ pendingDays: 8, tickDays: 8 }), 1);
});
test("D2 tickProgress never exceeds 1 on a backlog", () => {
    assert.equal(tickProgress({ pendingDays: 40, tickDays: 8 }), 1);
});
test("D3 the shown date counts backlog plus the slice being simulated", () => {
    assert.equal(displayDayOffset({ pendingDays: 2.7, inFlightDays: 8 }), 10);
});
test("D4 the shown date never runs backwards across a commit", () => {
    // Before the commit: 8 days in flight, 2.7 more accrued -> +10 days shown.
    const before = displayDayOffset({ pendingDays: 2.7, inFlightDays: 8 });
    // The commit moves 8 days into the game date itself and clears the slice.
    const after = 8 + displayDayOffset({ pendingDays: 2.7, inFlightDays: 0 });
    assert.equal(after, before);
});
test("D5 an idle clock shows no offset", () => {
    assert.equal(displayDayOffset({ pendingDays: 0, inFlightDays: 0 }), 0);
});
