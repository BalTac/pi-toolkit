/**
 * Goal Mode Extension
 *
 * /goal command that:
 * 1. Takes a task description
 * 2. Asks the AI to create a detailed roadmap
 * 3. Shows the roadmap for user approval
 * 4. Upon approval, executes the roadmap step by step
 * 5. Tracks progress visually with a widget and status indicator
 *
 * Commands:
 *   /goal <description>  - Create a new goal with roadmap
 *   /goal status         - Show current goal progress
 *   /goal cancel         - Cancel the current goal
 *   /goal steps          - List all steps with status
 *   /goal approve        - Approve a pending roadmap
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Types ────────────────────────────────────────────────────────────────────

interface GoalStep {
	id: number;
	description: string;
	completed: boolean;
}

interface GrillOption {
	label: string;
	recommended?: boolean;
	isCustom?: boolean;
}

interface GrillQuestion {
	id: number;
	question: string;
	options: GrillOption[];
}

interface GrillAnswer {
	questionId: number;
	question: string;
	answer: string;
}

interface GoalState {
	active: boolean;
	mode: "goal" | "grill";
	phase:
		| "idle"
		| "grill_interviewing"
		| "planning"
		| "awaiting_approval"
		| "executing"
		| "completed";
	title: string;
	steps: GoalStep[];
	currentStep: number;
	grillQuestions?: GrillQuestion[];
	grillAnswers?: GrillAnswer[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function freshState(): GoalState {
	return {
		active: false,
		mode: "goal",
		phase: "idle",
		title: "",
		steps: [],
		currentStep: 0,
	};
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function goalModeExtension(pi: ExtensionAPI) {
	let goalState: GoalState = freshState();

	// ── Persistence ────────────────────────────────────────────────────────

	function persistState(): void {
		pi.appendEntry("goal-mode", goalState);
	}

	// ── UI Updates ─────────────────────────────────────────────────────────

	function updateUI(ctx: ExtensionContext): void {
		const isGrill = goalState.mode === "grill";
		const icon = isGrill ? "🔥" : "🎯";

		// --- Status bar ---
		if (!goalState.active) {
			ctx.ui.setStatus("goal-mode", undefined);
		} else if (goalState.phase === "grill_interviewing") {
			const answered = goalState.grillAnswers?.length ?? 0;
			const total = goalState.grillQuestions?.length ?? 0;
			ctx.ui.setStatus(
				"goal-mode",
				ctx.ui.theme.fg("accent", `🔥 Q&A ${answered}/${total}`),
			);
		} else if (goalState.phase === "planning") {
			ctx.ui.setStatus("goal-mode", ctx.ui.theme.fg("dim", `${icon} planning...`));
		} else if (goalState.phase === "awaiting_approval") {
			ctx.ui.setStatus("goal-mode", ctx.ui.theme.fg("warning", `${icon} pending approval`));
		} else if (goalState.phase === "executing") {
			const completed = goalState.steps.filter((s) => s.completed).length;
			const total = goalState.steps.length;
			ctx.ui.setStatus("goal-mode", ctx.ui.theme.fg("accent", `${icon} ${completed}/${total}`));
		} else if (goalState.phase === "completed") {
			ctx.ui.setStatus("goal-mode", ctx.ui.theme.fg("success", `${icon} completed!`));
		}

		// --- Widget: Interview questions (grill_interviewing) ---
		if (
			goalState.active &&
			goalState.phase === "grill_interviewing" &&
			goalState.grillQuestions &&
			goalState.grillQuestions.length > 0
		) {
			const lines: string[] = [];
			lines.push(
				ctx.ui.theme.fg(
					"accent",
					ctx.ui.theme.bold(`🔥 Grill: ${goalState.title}`),
				),
			);
			lines.push(
				ctx.ui.theme.fg(
					"dim",
					"  Answer the questions to shape your roadmap...",
				),
			);
			lines.push("");

			const answeredIds = new Set(
				(goalState.grillAnswers ?? []).map((a) => a.questionId),
			);
			for (const q of goalState.grillQuestions) {
				const answered = answeredIds.has(q.id);
				const existingAnswer = (goalState.grillAnswers ?? []).find(
					(a) => a.questionId === q.id,
				);
				if (answered && existingAnswer) {
					lines.push(
						ctx.ui.theme.fg("success", `  ✓ Q${q.id}: `) +
							ctx.ui.theme.fg("muted", existingAnswer.answer),
					);
				} else {
					lines.push(
						ctx.ui.theme.fg("dim", `  ○ Q${q.id}: `) +
							ctx.ui.theme.fg("dim", q.question),
					);
				}
			}
			ctx.ui.setWidget("goal-progress", lines);
		} else if (goalState.active && goalState.steps.length > 0) {
			// --- Widget: Roadmap steps ---
			const lines: string[] = [];
			const label = isGrill ? `🔥 Grill: ${goalState.title}` : `🎯 Goal: ${goalState.title}`;
			lines.push(
				ctx.ui.theme.fg("accent", ctx.ui.theme.bold(label)),
			);

			// Show interview answers summary if in grill mode
			if (
				isGrill &&
				goalState.grillAnswers &&
				goalState.grillAnswers.length > 0
			) {
				for (const a of goalState.grillAnswers) {
					lines.push(
						ctx.ui.theme.fg("dim", `     Q${a.questionId}: `) +
							ctx.ui.theme.fg("muted", a.answer),
					);
				}
				lines.push("");
			}

			if (goalState.phase === "awaiting_approval") {
				lines.push(ctx.ui.theme.fg("warning", "  ⏳ Awaiting your approval..."));
			}

			lines.push("");

			for (const step of goalState.steps) {
				const isCurrent =
					step.id === goalState.currentStep &&
					goalState.phase === "executing";
				if (step.completed) {
					lines.push(
						ctx.ui.theme.fg("success", "  ✓ ") +
							ctx.ui.theme.fg(
								"muted",
								ctx.ui.theme.strikethrough(step.description),
							),
					);
				} else if (isCurrent) {
					lines.push(
						ctx.ui.theme.fg("accent", "  ▶ ") +
							ctx.ui.theme.fg("accent", step.description),
					);
				} else {
					lines.push(
						ctx.ui.theme.fg("dim", `  ${step.id}. `) +
							ctx.ui.theme.fg("dim", step.description),
					);
				}
			}
			ctx.ui.setWidget("goal-progress", lines);
		} else {
			ctx.ui.setWidget("goal-progress", undefined);
		}
	}

	// ── Tool: goal_set_roadmap ─────────────────────────────────────────────
	// Called by the AI after analyzing the goal and creating the plan.

	pi.registerTool({
		name: "goal_set_roadmap",
		label: "Set Goal Roadmap",
		description:
			"Store the roadmap/steps for the current goal. Call this after you have analyzed the user's goal, explored the codebase if needed, and created a detailed step-by-step plan. Steps must be concrete, actionable, and logically ordered. Include 3-10 steps.",
		promptSnippet:
			"Set a roadmap of concrete, ordered steps for the current goal",
		promptGuidelines: [
			"Use goal_set_roadmap when you have finished analyzing the goal and created a detailed step-by-step plan. The user will review and approve the roadmap before execution begins.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short descriptive title for the goal" }),
			steps: Type.Array(
				Type.Object({
					description: Type.String({
						description:
							"Concrete, actionable step description. Must be specific enough to execute independently.",
					}),
				}),
				{
					description: "Ordered list of steps (3-10) to complete the goal",
					minItems: 1,
				},
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Agents can drive their own jobs with the goal tools. When no /goal
			// session was started interactively, calling this tool bootstraps one
			// instead of failing (useful for autonomous/subagent/headless work).
			if (!goalState.active && goalState.phase === "idle") {
				goalState = {
					...freshState(),
					active: true,
					mode: "goal",
					phase: "planning",
				};
			}

			if (!goalState.active || goalState.phase !== "planning") {
				const reason =
					goalState.phase === "awaiting_approval"
						? 'A roadmap is already awaiting approval. Approve it first (or wait for the approval prompt).'
						: goalState.phase === "executing"
							? 'A goal is already executing. Complete or cancel it before setting a new roadmap.'
							: goalState.mode === "grill"
								? 'Finish the interview (grill_submit_interview) before setting a roadmap.'
								: 'Cannot set a roadmap right now (active goal phase: "' +
									goalState.phase +
									'").';
				return {
					content: [
						{
							type: "text",
							text: 'Error: ' + reason,
						},
					],
				};
			}

			const { title, steps } = params as {
				title: string;
				steps: { description: string }[];
			};

			goalState.title = title;
			goalState.steps = steps.map((s, i) => ({
				id: i + 1,
				description: s.description,
				completed: false,
			}));
			goalState.currentStep = 1;
			goalState.phase = "awaiting_approval";
			persistState();
			updateUI(ctx);

			const roadmapText = goalState.steps
				.map((s) => `${s.id}. ${s.description}`)
				.join("\n");

			const approvalHint = ctx.hasUI
				? `The roadmap has been set. The user will now review and either approve, refine, or cancel it.\n` +
					`Do NOT take any further action until the user responds.`
				: `Roadmap stored (unattended session: it will be approved automatically and executed step by step).\n` +
					`Stop here — the next instruction tells you which step to run.`;

			return {
				content: [
					{
						type: "text",
						text: `## Roadmap: ${title}\n\n${roadmapText}\n\n---\n${approvalHint}`,
					},
				],
			};
		},
	});

	// ── Tool: goal_complete_step ───────────────────────────────────────────
	// Called by the AI after finishing the current step of the roadmap.

	pi.registerTool({
		name: "goal_complete_step",
		label: "Complete Goal Step",
		description:
			"Mark the current step of the active goal as completed and advance to the next step. Call this immediately after you have fully completed the current step. When all steps are done, the goal is marked as completed.",
		promptSnippet:
			"Mark the current goal step as done and advance to the next step",
		promptGuidelines: [
			"Use goal_complete_step immediately after completing the current step of the active goal. Include a brief summary of what was accomplished. After calling this tool, automatically continue with the next step if one remains.",
		],
		parameters: Type.Object({
			summary: Type.Optional(
				Type.String({
					description: "Brief one-line summary of what was accomplished in this step",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!goalState.active) {
				return {
					content: [
						{
							type: "text",
							text: 'Error: No active goal. Use /goal "<description>" to start one, or call goal_set_roadmap first.',
						},
					],
				};
			}

			// Unattended sessions (print/json/agent jobs) auto-approve the roadmap.
			// If the agent kept working in the same run without waiting for the
			// approval hand-off, promote to execution instead of erroring out.
			if (goalState.phase === "awaiting_approval") {
				if (ctx.hasUI) {
					return {
						content: [
							{
								type: "text",
								text: "Error: The roadmap is awaiting your approval. Stop and wait for the user to approve it before executing steps.",
							},
						],
					};
				}
				goalState.phase = "executing";
				goalState.currentStep = goalState.steps.find((s) => !s.completed)?.id ?? 1;
				persistState();
				updateUI(ctx);
			}

			if (goalState.phase !== "executing") {
				return {
					content: [
						{
							type: "text",
							text: "Error: No goal is currently being executed.",
						},
					],
				};
			}

			const currentStepIdx = goalState.steps.findIndex(
				(s) => s.id === goalState.currentStep,
			);
			if (currentStepIdx === -1) {
				return {
					content: [
						{ type: "text", text: "Error: Current step not found in roadmap." },
					],
				};
			}

			const { summary } = params as { summary?: string };
			const completedStep = goalState.steps[currentStepIdx];
			goalState.steps[currentStepIdx].completed = true;
			const summarySuffix = summary ? ` — ${summary}` : "";

			// Check if all steps are done
			if (goalState.steps.every((s) => s.completed)) {
				goalState.phase = "completed";
				goalState.active = false;
				persistState();
				updateUI(ctx);

				const allSteps = goalState.steps
					.map((s) => `✓ ${s.description}`)
					.join("\n");

				return {
					content: [
						{
							type: "text",
							text:
								`✅ Step ${completedStep.id}/${goalState.steps.length} complete${summarySuffix}.\n\n` +
								`🎉 **Goal Achieved: ${goalState.title}**\n\n` +
								`All steps completed:\n${allSteps}\n\n` +
								`The goal has been marked as complete. Great work!\n` +
								`No more steps remain: reply with a concise final summary of what was accomplished (no further tool calls).`,
						},
					],
				};
			}

			// Move to next incomplete step
			const nextStep = goalState.steps.find((s) => !s.completed);
			if (nextStep) {
				goalState.currentStep = nextStep.id;
			}

			const totalSteps = goalState.steps.length;
			const completedCount = goalState.steps.filter((s) => s.completed).length;

			persistState();
			updateUI(ctx);

			const nextLine = nextStep
				? `\n▶ **Next (${nextStep.id}/${totalSteps})**: ${nextStep.description}`
				: "";

			return {
				content: [
					{
						type: "text",
						text:
							`✅ **Step ${completedStep.id}/${totalSteps} complete**${summarySuffix}\n` +
							`Progress: ${completedCount}/${totalSteps} steps done.${nextLine}\n\n` +
							(nextStep
								? `Continue by working on the next step.`
								: `All done!`),
					},
				],
			};
		},
	});

	// ── Tool: grill_submit_interview ────────────────────────────────────
	// Called by the AI to present interview questions to the user.
	// The tool shows each question interactively and collects answers.

	pi.registerTool({
		name: "grill_submit_interview",
		label: "Submit Interview Questions",
		description:
			"Present interview questions to the user about their task. Call this after you have designed 3-7 multiple-choice questions to clarify the user's requirements. Each question must have 2-5 options, one marked as recommended, and always include an 'Altro...' option for custom answers. The answers will be used to create a precise roadmap.",
		promptSnippet:
			"Show interview questions to the user and collect their answers",
		promptGuidelines: [
			"Use grill_submit_interview when in /grill-me mode and you need to clarify requirements before building a roadmap. Design 3-7 focused questions, each with one recommended option and always include 'Altro...' (isCustom: true) as the last option.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({
						description:
							"The question to ask the user. Must be clear and focused.",
					}),
					options: Type.Array(
						Type.Object({
							label: Type.String({
								description:
									"The option text shown to the user.",
							}),
							recommended: Type.Optional(
								Type.Boolean({
									description:
										"True if this is the recommended/best-practice option.",
								}),
							),
							isCustom: Type.Optional(
								Type.Boolean({
									description:
										"True if this is the 'Altro...' option that lets the user type a custom answer.",
								}),
							),
						}),
						{
							description:
								"Options for this question. At least 2, max 5. One should be recommended. Always include an 'Altro...' option with isCustom: true as the last option.",
							minItems: 2,
							maxItems: 5,
						},
					),
				}),
				{
					description:
						"Ordered list of 3-7 interview questions. Each question clarifies one aspect of the task.",
					minItems: 3,
					maxItems: 7,
				},
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (
				!goalState.active ||
				goalState.mode !== "grill" ||
				goalState.phase !== "grill_interviewing"
			) {
				return {
					content: [
						{
							type: "text",
							text: 'Error: Not in /grill-me interview phase. Use /grill-me "<description>" first.',
						},
					],
				};
			}

			const { questions } = params as {
				questions: {
					question: string;
					options: { label: string; recommended?: boolean; isCustom?: boolean }[];
				}[];
			};

			// Store questions in state
			goalState.grillQuestions = questions.map((q, i) => ({
				id: i + 1,
				question: q.question,
				options: q.options,
			}));
			goalState.grillAnswers = [];
			persistState();
			updateUI(ctx);

			// Show each question interactively
			const answers: GrillAnswer[] = [];
			const totalQuestions = goalState.grillQuestions.length;

			for (let i = 0; i < goalState.grillQuestions.length; i++) {
				const q = goalState.grillQuestions[i];

				// Build select items: normal options + "Altro..." custom
				const selectItems: string[] = q.options.map((opt) => {
					let label = opt.label;
					if (opt.recommended) label += " ★";
					return label;
				});

				// Check for cancellation between questions
				const title = `🎯 Q${q.id}/${totalQuestions}`;
				const choice = await ctx.ui.select(title + ": " + q.question, selectItems);

				if (choice === undefined) {
					// User cancelled (Escape) — abort interview
					goalState = freshState();
					persistState();
					updateUI(ctx);
					return {
						content: [
							{
								type: "text",
								text: "Interview cancelled by user. The goal has been reset.",
							},
						],
					};
				}

				// Check if user picked "Altro..." (isCustom option)
				let selectedOption = choice;
				// Remove the " ★" suffix if present
				if (selectedOption.endsWith(" ★")) {
					selectedOption = selectedOption.slice(0, -2);
				}

				const pickedOption = q.options.find(
					(opt) => opt.label === selectedOption,
				);

				let answerText = selectedOption;

				if (pickedOption?.isCustom) {
					// Show text input for custom answer
					const customAnswer = await ctx.ui.input(
						"✏️ Your custom answer:",
						"Type your answer...",
					);
					if (customAnswer === undefined || customAnswer.trim() === "") {
						// User cancelled or empty — retry the same question
						i--;
						continue;
					}
					answerText = customAnswer.trim();
				}

				// Store answer
				const answer: GrillAnswer = {
					questionId: q.id,
					question: q.question,
					answer: answerText,
				};
				answers.push(answer);
				goalState.grillAnswers = [...answers];
				persistState();
				updateUI(ctx);
			}

			// All questions answered — advance to planning phase
			goalState.phase = "planning";
			persistState();
			updateUI(ctx);

			// Format answers for the AI
			const answersSummary = answers
				.map((a) => `**Q${a.questionId}**: ${a.question}\\n  → Answer: ${a.answer}`)
				.join("\n\n");

			return {
				content: [
					{
						type: "text",
						text:
							`## Interview Complete — ${answers.length}/${totalQuestions} questions answered\n\n` +
							`${answersSummary}\n\n` +
							`---\n` +
							`Use these answers to create a precise roadmap for: **${goalState.title}**.\n` +
							`Call **goal_set_roadmap** with a title and ordered steps that reflect the user's preferences above.`,
					},
				],
			};
		},
	});

	// ── Command: /goal ─────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set a goal, create a roadmap, and execute it step by step",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["status", "cancel", "steps", "approve"];
			const items = subcommands
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = (args || "").trim();
			const lower = trimmedArgs.toLowerCase();

			// ── /goal status ────────────────────────────────────────────
			if (lower === "status" || lower === "s") {
				if (!goalState.active) {
					ctx.ui.notify(
						"No active goal. Use /goal <description> to start one.",
						"info",
					);
					return;
				}
				const completed = goalState.steps.filter((s) => s.completed).length;
				const total = goalState.steps.length;
				const stepsList = goalState.steps
					.map((s) => {
						const icon = s.completed
							? "✓"
							: s.id === goalState.currentStep && goalState.phase === "executing"
								? "▶"
								: "○";
						return `  ${icon} ${s.id}. ${s.description}`;
					})
					.join("\n");

				ctx.ui.notify(
					`🎯 Goal: ${goalState.title}\n` +
						`Phase: ${goalState.phase}\n` +
						`Progress: ${completed}/${total} steps\n\n${stepsList}`,
					"info",
				);
				return;
			}

			// ── /goal cancel ────────────────────────────────────────────
			if (lower === "cancel" || lower === "c") {
				if (!goalState.active) {
					ctx.ui.notify("No active goal to cancel.", "info");
					return;
				}
				const ok = await ctx.ui.confirm(
					"Cancel Goal",
					`Cancel goal "${goalState.title}"? All progress will be lost.`,
				);
				if (ok) {
					goalState = freshState();
					persistState();
					updateUI(ctx);
					ctx.ui.notify("Goal cancelled.", "info");
				}
				return;
			}

			// ── /goal steps ─────────────────────────────────────────────
			if (lower === "steps" || lower === "ls") {
				if (!goalState.active || goalState.steps.length === 0) {
					ctx.ui.notify(
						"No steps yet. Create a goal first with /goal <description>",
						"info",
					);
					return;
				}
				const stepsList = goalState.steps
					.map((s) => {
						const icon = s.completed
							? "✓"
							: s.id === goalState.currentStep && goalState.phase === "executing"
								? "▶"
								: "○";
						return `  ${icon} ${s.id}. ${s.description}`;
					})
					.join("\n");
				ctx.ui.notify(
					`🎯 ${goalState.title} — ${goalState.phase}\n\n${stepsList}`,
					"info",
				);
				return;
			}

			// ── /goal approve ───────────────────────────────────────────
			if (lower === "approve") {
				if (
					!goalState.active ||
					goalState.phase !== "awaiting_approval"
				) {
					ctx.ui.notify(
						"No roadmap is awaiting approval. Use /goal <description> to create one.",
						"info",
					);
					return;
				}
				await startExecution(ctx);
				return;
			}

			// ── /goal (no args) — show help ─────────────────────────────
			if (!trimmedArgs) {
				ctx.ui.notify(
					"🎯 Goal Mode\n\n" +
						"  /goal <description>    Create a new goal with AI-generated roadmap\n" +
						"  /goal status            Show current goal and progress\n" +
						"  /goal cancel            Cancel the active goal\n" +
						"  /goal steps             List all roadmap steps\n" +
						"  /goal approve           Approve a pending roadmap\n" +
						"\n🔥 See also: /grill-me — interview-driven goal mode",
					"info",
				);
				return;
			}

			// ── /goal <description> — start a new goal ──────────────────
			if (goalState.active) {
				const ok = await ctx.ui.confirm(
					"Active Goal Exists",
					`A goal is already active: "${goalState.title}". Replace it with a new one?`,
				);
				if (!ok) return;
			}

			// Start planning phase
			goalState = freshState();
			goalState.active = true;
			goalState.phase = "planning";
			persistState();
			updateUI(ctx);

			// Ask the AI to analyze and create a roadmap
			pi.sendUserMessage(
				`🎯 **GOAL**: ${trimmedArgs}

Please analyze this goal and create a detailed, actionable roadmap. Follow these steps carefully:

1. **Understand the goal** — Make sure you fully understand what the user wants.
2. **Explore the codebase** — Use read, bash, grep, find, and ls to understand the current state of the project relevant to this goal.
3. **Design the roadmap** — Break the goal into concrete, ordered steps (ideally 3-10).
   - Each step must be specific, self-contained, and actionable.
   - Steps must be in logical execution order.
   - Include any necessary setup, implementation, testing, and validation steps.
   - Be realistic about what can be done in each step.
4. **Call goal_set_roadmap** — Once you have a solid plan, call the goal_set_roadmap tool with:
   - A short, descriptive title for the goal
   - The ordered list of step descriptions

After you call goal_set_roadmap, the user will review and approve the plan before execution begins.
Do NOT start implementing anything — just create the roadmap.`,
			);
		},
	});

	// ── Command: /grill-me ──────────────────────────────────────────────

	pi.registerCommand("grill-me", {
		description:
			"Interview you about a task, then create a roadmap and execute it",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["status", "cancel", "steps", "approve"];
			const items = subcommands
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = (args || "").trim();
			const lower = trimmedArgs.toLowerCase();

			// ── /grill-me status ──────────────────────────────────────
			if (lower === "status" || lower === "s") {
				if (!goalState.active || goalState.mode !== "grill") {
					ctx.ui.notify(
						"No active grill-me session. Use /grill-me <description> to start one.",
						"info",
					);
					return;
				}
				const completed = goalState.steps.filter((s) => s.completed).length;
				const total = goalState.steps.length;

				let info = `🔥 Grill: ${goalState.title}\nPhase: ${goalState.phase}\n`;
				if (goalState.grillAnswers && goalState.grillAnswers.length > 0) {
					info += `Interview: ${goalState.grillAnswers.length}/${goalState.grillQuestions?.length ?? "?"} answered\n`;
					for (const a of goalState.grillAnswers) {
						info += `  Q${a.questionId}: ${a.answer}\n`;
					}
				}
				if (goalState.steps.length > 0) {
					info += `Progress: ${completed}/${total} steps\n`;
					const stepsList = goalState.steps
						.map((s) => {
							const icon = s.completed
								? "✓"
								: s.id === goalState.currentStep &&
									goalState.phase === "executing"
									? "▶"
									: "○";
							return `  ${icon} ${s.id}. ${s.description}`;
						})
						.join("\n");
					info += `\n${stepsList}`;
				}
				ctx.ui.notify(info, "info");
				return;
			}

			// ── /grill-me cancel ──────────────────────────────────────
			if (lower === "cancel" || lower === "c") {
				if (!goalState.active || goalState.mode !== "grill") {
					ctx.ui.notify("No active grill-me session to cancel.", "info");
					return;
				}
				const ok = await ctx.ui.confirm(
					"Cancel Grill",
					`Cancel grill session "${goalState.title}"? All progress will be lost.`,
				);
				if (ok) {
					goalState = freshState();
					persistState();
					updateUI(ctx);
					ctx.ui.notify("Grill session cancelled.", "info");
				}
				return;
			}

			// ── /grill-me steps ───────────────────────────────────────
			if (lower === "steps" || lower === "ls") {
				if (
					!goalState.active ||
					goalState.mode !== "grill" ||
					goalState.steps.length === 0
				) {
					ctx.ui.notify(
						"No steps yet. The interview must be completed first.",
						"info",
					);
					return;
				}
				const stepsList = goalState.steps
					.map((s) => {
						const icon = s.completed
							? "✓"
							: s.id === goalState.currentStep &&
								goalState.phase === "executing"
								? "▶"
								: "○";
						return `  ${icon} ${s.id}. ${s.description}`;
					})
					.join("\n");
				ctx.ui.notify(
					`🔥 ${goalState.title} — ${goalState.phase}\n\n${stepsList}`,
					"info",
				);
				return;
			}

			// ── /grill-me approve ─────────────────────────────────────
			if (lower === "approve") {
				if (
					!goalState.active ||
					goalState.mode !== "grill" ||
					goalState.phase !== "awaiting_approval"
				) {
					ctx.ui.notify(
						"No roadmap is awaiting approval. Complete the interview first.",
						"info",
					);
					return;
				}
				await startExecution(ctx);
				return;
			}

			// ── /grill-me (no args) — show help ───────────────────────
			if (!trimmedArgs) {
				ctx.ui.notify(
					"🔥 Grill Me Mode — Interview-driven implementation\n\n" +
						"  /grill-me <description>  Start a new task with AI interview\n" +
						"  /grill-me status          Show interview answers + roadmap progress\n" +
						"  /grill-me cancel          Cancel the active grill session\n" +
						"  /grill-me steps           List roadmap steps\n" +
						"  /grill-me approve         Approve a pending roadmap",
					"info",
				);
				return;
			}

			// ── /grill-me <description> — start new grill session ─────
			if (goalState.active) {
				const ok = await ctx.ui.confirm(
					"Active Session Exists",
					`A ${goalState.mode === "grill" ? "grill" : "goal"} session is already active: "${goalState.title}". Replace it?`,
				);
				if (!ok) return;
			}

			// Start grill interview phase
			goalState = freshState();
			goalState.active = true;
			goalState.mode = "grill";
			goalState.phase = "grill_interviewing";
			goalState.title = trimmedArgs;
			persistState();
			updateUI(ctx);

			// Ask AI to design interview questions
			pi.sendUserMessage(
				`🔥 **GRILL TASK**: ${trimmedArgs}

You are in **grill-me mode**. Before creating a roadmap, you must interview the user to clarify requirements.

Your task:
1. **Understand the task** — Analyze what the user wants.
2. **Explore the codebase** — Use read, bash, grep, find, ls to understand the current project state.
3. **Design 3-7 interview questions** — Create focused multiple-choice questions to clarify:
   - Technical choices (frameworks, libraries, patterns)
   - Architecture decisions (structure, naming, conventions)
   - Scope and priorities (MVP vs full, must-have vs nice-to-have)
   - Existing code integration (where to hook in, what to modify)
   - Any other relevant aspect

Question rules:
- Each question: 2-5 options (including the custom one)
- One option per question must be marked **recommended: true** (your best-practice pick)
- The LAST option of EVERY question MUST be: { "label": "Altro...", "isCustom": true }
- Questions must be in logical order, from broad to specific
- Make questions concrete and actionable — the answers will shape the roadmap

4. **Call grill_submit_interview** — Pass your questions array. The user will answer interactively.

Do NOT create a roadmap yet. Wait for the interview results.`,
			);
		},
	});

	// ── Start execution helper ─────────────────────────────────────────────

	async function startExecution(ctx: ExtensionContext): Promise<void> {
		if (!goalState.active) return;

		goalState.phase = "executing";
		goalState.currentStep = goalState.steps.find((s) => !s.completed)?.id || 1;
		persistState();
		updateUI(ctx);

		const firstPending = goalState.steps.find((s) => !s.completed);
		if (!firstPending) {
			// All steps already done? Mark as complete.
			goalState.phase = "completed";
			goalState.active = false;
			persistState();
			updateUI(ctx);
			return;
		}

		const totalSteps = goalState.steps.length;
		const completedCount = goalState.steps.filter((s) => s.completed).length;

		// Show the full roadmap then start execution
		const allSteps = goalState.steps
			.map((s) => {
				if (s.completed) return `  ✓ ${s.description}`;
				if (s.id === firstPending.id) return `  ▶ ${s.description}`;
				return `  ○ ${s.description}`;
			})
			.join("\n");

		pi.sendMessage(
			{
				customType: "goal-start",
				content:
					`**🎯 Goal: ${goalState.title}**\n\n` +
					`Executing step by step (${completedCount}/${totalSteps} done)...\n\n` +
					`${allSteps}`,
				display: true,
			},
			{ deliverAs: "followUp" },
		);

		pi.sendUserMessage(
			`Execute the goal roadmap step by step.

▶ **Current step (${firstPending.id}/${totalSteps})**: ${firstPending.description}

Instructions:
- Focus ONLY on the current step.
- When you have fully completed it, call goal_complete_step with a brief summary.
- After calling goal_complete_step, automatically continue with the next step if one remains.
- If you encounter any blockers or need clarification, ask the user.
- Do NOT skip ahead to future steps.`,
			{ deliverAs: "followUp" },
		);
	}

	// ── Event: agent_end — handle approval and completion ──────────────────

	pi.on("agent_end", async (event, ctx) => {
		const hasUI = ctx.hasUI;

		// ── Awaiting approval — prompt user, or auto-approve when unattended ──
		if (
			goalState.active &&
			goalState.phase === "awaiting_approval" &&
			goalState.steps.length > 0
		) {
			if (!hasUI) {
				// No UI (print/json run, subagent, autonomous job): approve the
				// roadmap automatically so the goal executes without a human.
				await startExecution(ctx);
				return;
			}

			const roadmapText = goalState.steps
				.map((s, i) => `${i + 1}. ${s.description}`)
				.join("\n");

			const choice = await ctx.ui.select(
				`Review Roadmap: "${goalState.title}"\n\n${roadmapText}\n\n───\nApprove this plan?`,
				[
					"✅ Approve — Execute step by step",
					"✏️ Refine — Provide feedback to improve the plan",
					"❌ Cancel — Discard this goal",
				],
			);

			if (choice?.startsWith("✅")) {
				await startExecution(ctx);
			} else if (choice?.startsWith("✏️")) {
				const refinement = await ctx.ui.editor(
					"Provide feedback to refine the roadmap:",
					"",
				);
				if (refinement?.trim()) {
					// Reset to planning with feedback
					goalState.phase = "planning";
					goalState.steps = [];
					goalState.title = "";
					persistState();
					updateUI(ctx);
					pi.sendUserMessage(
						`Refine the roadmap based on this feedback:\n\n${refinement.trim()}\n\n` +
							`After refining, call goal_set_roadmap with the updated plan.`,
						{ deliverAs: "followUp" },
					);
				}
			} else {
				// Cancel
				goalState = freshState();
				persistState();
				updateUI(ctx);
				pi.sendMessage(
					{
						customType: "goal-cancelled",
						content: "🚫 Goal cancelled.",
						display: true,
					},
					{ deliverAs: "followUp" },
				);
			}
			return;
		}

		// ── Completed — celebrate (UI sessions) and reset state ────────
		if (goalState.phase === "completed") {
			if (hasUI) {
				const completedList = goalState.steps
					.map((s) => `✓ ${s.description}`)
					.join("\n");

				pi.sendMessage(
					{
						customType: "goal-complete",
						content:
							`## 🎉 Goal Achieved: ${goalState.title}\n\n` +
							`All steps completed:\n${completedList}`,
						display: true,
					},
					{ deliverAs: "followUp" },
				);
			}

			goalState = freshState();
			persistState();
			updateUI(ctx);
			return;
		}

		// ── Execution fallback: detect [DONE] tags ─────────────────────
		if (goalState.active && goalState.phase === "executing") {
			const lastAssistant = [...event.messages]
				.reverse()
				.find(isAssistantMessage);
			if (!lastAssistant) return;

			const text = getTextContent(lastAssistant);

			// Detect [DONE] or [DONE:summary] tags as a fallback
			const doneRegex = /\[DONE(?::\s*(.*?))?\]/gi;
			const matches = [...text.matchAll(doneRegex)];
			if (matches.length > 0) {
				const summary = matches[matches.length - 1][1]?.trim();

				// Find current step
				const currentStepIdx = goalState.steps.findIndex(
					(s) => s.id === goalState.currentStep,
				);
				if (currentStepIdx !== -1) {
					goalState.steps[currentStepIdx].completed = true;

					// Check for completion
					if (goalState.steps.every((s) => s.completed)) {
						goalState.phase = "completed";
						goalState.active = false;
					} else {
						const nextStep = goalState.steps.find((s) => !s.completed);
						if (nextStep) goalState.currentStep = nextStep.id;
					}

					persistState();
					updateUI(ctx);

					// If more steps remain and no tool was called implicitly, nudge the AI
					if (
						goalState.active &&
						goalState.phase === "executing"
					) {
						const next = goalState.steps.find((s) => !s.completed);
						if (next) {
							pi.sendUserMessage(
								`Continue with the next step: ▶ ${next.id}/${goalState.steps.length}: ${next.description}`,
								{ deliverAs: "followUp" },
							);
						}
					}
				}
			}
		}
	});

	// ── Event: before_agent_start — inject execution context ───────────────

	pi.on("before_agent_start", async () => {
		if (!goalState.active) return;

		const isGrill = goalState.mode === "grill";

		// ── Grill planning: inject interview answers as context ─────────
		if (
			isGrill &&
			goalState.phase === "planning" &&
			goalState.grillAnswers &&
			goalState.grillAnswers.length > 0
		) {
			const answersText = goalState.grillAnswers
				.map((a) => `  Q${a.questionId}: ${a.question}\n    → **${a.answer}**`)
				.join("\n\n");

			return {
				message: {
					customType: "grill-answers-context",
					content:
						`[GRILL INTERVIEW RESULTS]
The user answered the following interview questions about: **${goalState.title}**

${answersText}

Use these answers to create a precise roadmap via **goal_set_roadmap**. The roadmap must reflect the user's preferences stated above.`,
					display: false,
				},
			};
		}

		// ── Execution context ───────────────────────────────────────────
		if (goalState.phase !== "executing") return;

		const remaining = goalState.steps.filter((s) => !s.completed);
		const completed = goalState.steps.filter((s) => s.completed);
		const currentStep = remaining[0];

		if (!currentStep) return;

		const modeLabel = isGrill
			? "GRILL EXECUTION (UNATTENDED)"
			: "GOAL EXECUTION MODE";

		let context = `[${modeLabel}]
You are executing the ${isGrill ? "grill" : "goal"}: **"${goalState.title}"**
Progress: ${completed.length}/${goalState.steps.length} steps done.

`;

		if (isGrill && goalState.grillAnswers && goalState.grillAnswers.length > 0) {
			context += `Interview answers:\n${goalState.grillAnswers.map((a) => `  Q${a.questionId}: ${a.answer}`).join("\n")}\n\n`;
		}

		if (completed.length > 0) {
			context += `Completed:\n${completed.map((s) => `  ✓ ${s.id}. ${s.description}`).join("\n")}\n\n`;
		}

		context += `Remaining:\n${remaining.map((s) => `  ○ ${s.id}. ${s.description}`).join("\n")}\n\n`;
		context +=
			`▶ **Current step (${currentStep.id}/${goalState.steps.length})**: ${currentStep.description}\n\n`;
		context += `Focus ONLY on the current step. When you have fully completed it, call **goal_complete_step** with a brief summary. Do NOT move to the next step before calling the tool.`;

		if (isGrill) {
			context += `\n\nThis is an UNATTENDED grill execution. The user's preferences were already collected via interview. Do NOT ask for permission or clarification — make autonomous decisions based on the interview answers. Only escalate if you hit a hard technical blocker you cannot resolve alone.`;
		}

		return {
			message: {
				customType: "goal-execution-context",
				content: context,
				display: false,
			},
		};
	});

	// ── Event: session_start — restore persisted state ─────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Restore persisted state from session entries
		const goalEntry = ctx.sessionManager
			.getEntries()
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "goal-mode",
			)
			.pop() as { data?: GoalState } | undefined;

		if (goalEntry?.data) {
			goalState = goalEntry.data;
		}

		if (goalState.active) {
			updateUI(ctx);
		}
	});

	// ── Event: session_shutdown — save state ───────────────────────────────

	pi.on("session_shutdown", async () => {
		persistState();
	});
}
