import type { spawnSync } from "node:child_process";
import type { SummarizeArgs, SummarizeProvider, SummarizeResult } from "./index";
import { runClaudeCli } from "../../claude-cli";

export const claudeCliProvider: SummarizeProvider = {
  name: "claude-cli",
  summarize(
    args: SummarizeArgs & { spawn?: typeof spawnSync },
  ): Promise<SummarizeResult> {
    const { text, tokens } = runClaudeCli(
      { model: args.model, systemPrompt: args.systemPrompt, userPrompt: args.userPrompt },
      args.spawn ? { spawn: args.spawn } : {},
    );
    if (text === null) {
      return Promise.reject(new Error("claude-cli provider produced no output"));
    }
    return Promise.resolve({ summary: text, cost: 0, tokens });
  },
};
