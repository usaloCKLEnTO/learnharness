import assert from "node:assert/strict";
import { it } from "node:test";
import { startQuestionClock, selectQuestionAnswer, stopQuestionClock, setQuestionFocus, resumeQuestionClock, parseQuestionTiming } from "../src/core/question-timing.ts";
import { buildAnswer, compactAnswerForModel, type QuestionData } from "../src/core/question-core.ts";
import { newAnswerResult } from "../src/core/native-messages.ts";

it("records first and revised selections and freezes at Submit, before any upload delay", () => {
	let clock = startQuestionClock(1_000, true);
	clock = selectQuestionAnswer(clock, 52_000, [{ index: 2, label: "B" }], false);
	clock = selectQuestionAnswer(clock, 75_000, [{ index: 3, label: "C" }], false);
	clock = stopQuestionClock(clock, 113_000);
	assert.deepEqual(clock.timing, {
		elapsedMs: 112_000, activeMs: 112_000, interruptions: 0,
		selections: [
			{ answers: [{ index: 2, label: "B" }], dontKnow: false, elapsedMs: 51_000, activeMs: 51_000 },
			{ answers: [{ index: 3, label: "C" }], dontKnow: false, elapsedMs: 74_000, activeMs: 74_000 },
		],
	});
	assert.deepEqual(stopQuestionClock(clock, 150_000).timing, clock.timing);
});

it("counts app interruptions once and keeps active time separate from elapsed time", () => {
	let clock = startQuestionClock(1_000, true);
	clock = setQuestionFocus(clock, 11_000, false);
	clock = setQuestionFocus(clock, 12_000, false); // blur + visibility are the same interruption
	clock = setQuestionFocus(clock, 41_000, true);
	clock = stopQuestionClock(clock, 51_000);
	assert.deepEqual(clock.timing, { elapsedMs: 50_000, activeMs: 20_000, interruptions: 1, selections: [] });
});

it("resumes a persisted question without counting time away as active work", () => {
	let clock = startQuestionClock(1_000, true);
	clock = selectQuestionAnswer(clock, 11_000, [{ index: 2, label: "B" }], false);
	const restored = resumeQuestionClock(JSON.parse(JSON.stringify(clock)), 101_000, true);
	assert.ok(restored);
	assert.deepEqual(stopQuestionClock(restored, 111_000).timing, {
		elapsedMs: 110_000, activeMs: 20_000, interruptions: 1,
		selections: [{ answers: [{ index: 2, label: "B" }], dontKnow: false, elapsedMs: 10_000, activeMs: 10_000 }],
	});
});

it("persists timing in the answer and passes it to the teacher as its tool result", () => {
	const timing = { elapsedMs: 112_000, activeMs: 102_000, interruptions: 1,
		selections: [{ answers: [{ index: 3, label: "C" }], dontKnow: false, elapsedMs: 74_000, activeMs: 64_000 }] };
	const question: QuestionData = { id: "timed-check", kind: "quiz", question: "Pick C", mode: "single-select",
		options: [{ label: "B", value: "b" }, { label: "A", value: "a" }, { label: "C", value: "c" }],
		correctIndices: [3], createdAt: "2026-10-24T00:00:00Z" };
	const answer = buildAnswer(question, { values: ["c"], timing });
	assert.deepEqual(answer.timing, timing);
	assert.deepEqual(compactAnswerForModel(answer), { kind: "quiz", answers: [{ index: 3, label: "C" }], correct: true, timing });
	const result = newAnswerResult("timed-check", "quiz", answer);
	assert.match(JSON.stringify(result.content), /elapsedMs/);
	assert.deepEqual(result.details, answer);
});

it("does not invent measurements for legacy answers or accept impossible timing", () => {
	assert.equal(parseQuestionTiming(undefined), undefined);
	for (const raw of [
		{ elapsedMs: -1, activeMs: 0, interruptions: 0, selections: [] },
		{ elapsedMs: 10, activeMs: 11, interruptions: 0, selections: [] },
		{ elapsedMs: 10, activeMs: 10, interruptions: 0, selections: [{ answers: [], dontKnow: true, elapsedMs: 11, activeMs: 10 }] },
	]) assert.equal(parseQuestionTiming(raw), undefined);
	assert.equal("timing" in compactAnswerForModel({ kind: "quiz", questionText: "Old question", dontKnow: true, answers: [], answeredAt: "2026-10-24T00:00:00Z" }), false);
});

it("handles multi-select sets, deselection and don't-know without duplicate selection events", () => {
	let clock = startQuestionClock(0, true);
	clock = selectQuestionAnswer(clock, 1_000, [{ index: 1, label: "A" }], false);
	clock = selectQuestionAnswer(clock, 2_000, [{ index: 1, label: "A" }], false);
	clock = selectQuestionAnswer(clock, 3_000, [{ index: 1, label: "A" }, { index: 2, label: "B" }], false);
	clock = selectQuestionAnswer(clock, 4_000, [], true);
	assert.deepEqual(clock.timing.selections.map(s=>({ answers: s.answers, dontKnow: s.dontKnow, elapsedMs: s.elapsedMs })), [
		{ answers: [{ index: 1, label: "A" }], dontKnow: false, elapsedMs: 1_000 },
		{ answers: [{ index: 1, label: "A" }, { index: 2, label: "B" }], dontKnow: false, elapsedMs: 3_000 },
		{ answers: [], dontKnow: true, elapsedMs: 4_000 },
	]);
});
