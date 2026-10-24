"use client";

import { useEffect, useRef, useState } from "react";
import { Clock3Icon } from "lucide-react";
import {
	advanceQuestionClock, formatQuestionTime, resumeQuestionClock, selectQuestionAnswer,
	setQuestionFocus, startQuestionClock, stopQuestionClock,
	type QuestionClock, type QuestionTiming, type TimedSelection,
} from "@/src/core";

// Epoch-compatible for reloads, monotonic within a page even if the system clock changes.
const now = () => Math.round(performance.timeOrigin + performance.now());
const focused = () => document.visibilityState === "visible" && document.hasFocus();

export function useQuestionTimer(toolCallId: string, enabled: boolean) {
	const [clock, setClock] = useState<QuestionClock>();
	const current = useRef<QuestionClock>(undefined);
	const key = `lh.question-timer.${toolCallId}`;
	const save = (next: QuestionClock) => {
		current.current = next;
		setClock(next);
		try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Timing still works if storage is unavailable. */ }
	};
	useEffect(() => {
		if (!enabled) return;
		try {
			const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
			const restored = resumeQuestionClock(raw, now(), focused());
			if (restored) save(restored);
		} catch { /* An absent or corrupt checkpoint starts with the reveal button. */ }
		const onFocus = () => {
			if (current.current) save(setQuestionFocus(current.current, now(), focused()));
		};
		const onHide = () => {
			if (current.current) save(setQuestionFocus(current.current, now(), false));
		};
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		window.addEventListener("pagehide", onHide);
		const tick = window.setInterval(() => {
			if (current.current && !current.current.stopped) save(advanceQuestionClock(current.current, now()));
		}, 1000);
		return () => {
			window.clearInterval(tick);
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
			window.removeEventListener("pagehide", onHide);
			if (current.current) {
				const next = setQuestionFocus(current.current, now(), false);
				try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Best-effort checkpoint. */ }
			}
		};
	}, [key, enabled]);
	return {
		clock,
		start() { if (enabled && !current.current) save(startQuestionClock(now(), focused())); },
		select(answers: TimedSelection["answers"], dontKnow: boolean) {
			if (current.current) save(selectQuestionAnswer(current.current, now(), answers, dontKnow));
		},
		stop(): QuestionTiming | undefined {
			if (!current.current) return undefined;
			const stopped = stopQuestionClock(current.current, now());
			save(stopped);
			return stopped.timing;
		},
	};
}

export type QuestionTimer = ReturnType<typeof useQuestionTimer>;

export function QuestionTimerReadout({ timing, stopped = false }: { timing: QuestionTiming; stopped?: boolean }) {
	const last = timing.selections.at(-1);
	return (
		<span data-testid="question-timer" className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-1.5 font-mono text-xs tabular-nums text-muted-foreground">
			<span className="inline-flex items-center gap-1.5" role="timer" aria-label={stopped ? "Submitted after" : "Elapsed time"}>
				<Clock3Icon className="size-3.5" aria-hidden /> {formatQuestionTime(timing.elapsedMs)}
			</span>
			{last && <span>Selected at {formatQuestionTime(last.elapsedMs)}</span>}
			{timing.interruptions > 0 && <span title="Time with this app focused; time away remains in the elapsed total.">
				Active {formatQuestionTime(timing.activeMs)} · {timing.interruptions} {timing.interruptions === 1 ? "interruption" : "interruptions"}
			</span>}
		</span>
	);
}
