import type { BuildQueryOptionsInput } from './buildQueryOptions';
import type { ClaudeAgentRunParams } from './readNodeParameters';

/** 从节点运行参数提取扩展 SDK Options 字段 */
export function pickExtendedQueryFields(
	params: ClaudeAgentRunParams,
): Pick<
	BuildQueryOptionsInput,
	| 'thinkingEnabled'
	| 'maxThinkingTokens'
	| 'maxBudgetUsd'
	| 'forwardSubagentText'
	| 'outputFormatSchema'
	| 'outputFormatName'
	| 'toolSearchMode'
	| 'hooksJson'
	| 'subagentsEnabled'
	| 'subagentsJson'
	| 'primaryAgentJson'
> {
	return {
		thinkingEnabled: params.thinkingEnabled,
		maxThinkingTokens: params.maxThinkingTokens,
		maxBudgetUsd: params.maxBudgetUsd,
		forwardSubagentText: params.forwardSubagentText,
		outputFormatSchema: params.outputFormatSchema,
		outputFormatName: params.outputFormatName,
		toolSearchMode: params.toolSearchMode,
		hooksJson: params.hooksJson,
		subagentsEnabled: params.subagentsEnabled,
		subagentsJson: params.subagentsJson,
		primaryAgentJson: params.primaryAgentJson,
	};
}
