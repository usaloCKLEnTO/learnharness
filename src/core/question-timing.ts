import { Type } from "typebox";
import { Value } from "typebox/value";

/** Question timing is learner evidence, measured from reveal to the Submit click. */
export interface TimedSelection {
	answers: { index: number; label: string }[];
	dontKnow: boolean;
	elapsedMs: number;
	activeMs: number;
}

export interface QuestionTiming {
	elapsedMs: number;
	activeMs: number;
	interruptions: number;
	selections: TimedSelection[];
}

export interface QuestionClock {
	updatedAt: number;
	focused: boolean;
	stopped: boolean;
	timing: QuestionTiming;
}

const milliseconds = Type.Integer({ minimum: 0 });
const selectionSchema = Type.Object({
	answers: Type.Array(Type.Object({ index: Type.Integer({ minimum: 1 }), label: Type.String() })),
	dontKnow: Type.Boolean(), elapsedMs: milliseconds, activeMs: milliseconds,
});
const timingSchema = Type.Object({
	elapsedMs: milliseconds, activeMs: milliseconds,
	interruptions: Type.Integer({ minimum: 0 }), selections: Type.Array(selectionSchema),
});
const clockSchema = Type.Object({
	updatedAt: milliseconds, focused: Type.Boolean(), stopped: Type.Boolean(), timing: timingSchema,
});

/** Old answers omit timing. Malformed persisted/network timing never becomes performance evidence. */
export function parseQuestionTiming(raw: unknown): QuestionTiming | undefined {
	if (!Value.Check(timingSchema, raw)) return undefined;
	const timing = Value.Clean(timingSchema, structuredClone(raw)) as QuestionTiming;
	if (timing.activeMs > timing.elapsedMs) return undefined;
	let previousElapsed = 0, previousActive = 0;
	for (const selection of timing.selections) {
		if (selection.activeMs > selection.elapsedMs || selection.elapsedMs > timing.elapsedMs ||
			selection.activeMs > timing.activeMs || selection.elapsedMs < previousElapsed || selection.activeMs < previousActive) return undefined;
		previousElapsed = selection.elapsedMs;
		previousActive = selection.activeMs;
	}
	return timing;
}

export function startQuestionClock(now: number, focused: boolean): QuestionClock {
	return { updatedAt: now, focused, stopped: false,
		timing: { elapsedMs: 0, activeMs: 0, interruptions: 0, selections: [] } };
}

export function advanceQuestionClock(clock: QuestionClock, now: number): QuestionClock {
	if (clock.stopped) return clock;
	const delta = Math.max(0, now - clock.updatedAt);
	return { ...clock, updatedAt: Math.max(now, clock.updatedAt), timing: {
		...clock.timing,
		elapsedMs: clock.timing.elapsedMs + delta,
		activeMs: clock.timing.activeMs + (clock.focused ? delta : 0),
	} };
}

export function selectQuestionAnswer(clock: QuestionClock, now: number, answers: TimedSelection["answers"], dontKnow: boolean): QuestionClock {
	if (clock.stopped) return clock;
	const next = advanceQuestionClock(clock, now);
	const previous = next.timing.selections.at(-1);
	if (previous?.dontKnow === dontKnow && JSON.stringify(previous.answers) === JSON.stringify(answers)) return next;
	return { ...next, timing: { ...next.timing, selections: [...next.timing.selections, {
		answers, dontKnow, elapsedMs: next.timing.elapsedMs, activeMs: next.timing.activeMs,
	}] } };
}

export function stopQuestionClock(clock: QuestionClock, now: number): QuestionClock {
	return { ...advanceQuestionClock(clock, now), stopped: true };
}

export function setQuestionFocus(clock: QuestionClock, now: number, focused: boolean): QuestionClock {
	if (clock.stopped) return clock;
	const next = advanceQuestionClock(clock, now);
	return { ...next, focused, timing: { ...next.timing,
		interruptions: next.timing.interruptions + (next.focused && !focused ? 1 : 0),
	} };
}

/** A stale focused checkpoint cannot establish work while the app was closed. */
export function resumeQuestionClock(raw: unknown, now: number, focused: boolean): QuestionClock | undefined {
	if (!Value.Check(clockSchema, raw)) return undefined;
	const clock = Value.Clean(clockSchema, structuredClone(raw)) as QuestionClock;
	if (!parseQuestionTiming(clock.timing)) return undefined;
	return setQuestionFocus(setQuestionFocus(clock, clock.updatedAt, false), now, focused);
}

export function formatQuestionTime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
