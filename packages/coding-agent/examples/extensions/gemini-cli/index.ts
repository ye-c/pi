import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// We need to import or reimplement the shared Google utilities.
// For the extension, we'll implement simplified versions of the necessary helpers
// to avoid depending on internal pi-ai files that might change or be inaccessible.

function isThinkingPart(part: Record<string, unknown>): boolean {
	return "thought" in part;
}

function retainThoughtSignature(existing: string | undefined, newSig: string | undefined): string | undefined {
	if (!newSig) return existing;
	if (!existing) return newSig;
	return existing + newSig;
}

function _mapStopReasonString(reason: string | undefined): "stop" | "length" | "toolUse" | "error" {
	if (!reason) return "stop";
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function convertMessages(messages: Message[], _isGeminiCli: boolean): any[] {
	// Simplified message conversion for Gemini API
	const contents: any[] = [];
	for (const msg of messages) {
		const role = msg.role === "assistant" ? "model" : "user";
		const parts: any[] = [];

		if (typeof msg.content === "string") {
			parts.push({ text: sanitizeSurrogates(msg.content) });
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push({ text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					// Gemini CLI expects thought blocks, but only if the model supports it.
					// For simplicity in this extension, we'll pass it as text if we can't format it properly,
					// but Cloud Code Assist supports native thought parts for certain models.
					parts.push({
						text: `<thinking>\n${sanitizeSurrogates(block.thinking)}\n</thinking>`,
					});
				} else if (block.type === "toolCall") {
					parts.push({
						functionCall: {
							name: block.name,
							args: block.arguments || {},
						},
					});
				}
			}
		}

		if (parts.length > 0) {
			contents.push({ role, parts });
		}
	}

	// Collapse consecutive identical roles (Gemini requires alternating roles)
	const collapsed: any[] = [];
	for (const content of contents) {
		const last = collapsed[collapsed.length - 1];
		if (last && last.role === content.role) {
			last.parts.push(...content.parts);
		} else {
			collapsed.push(content);
		}
	}

	return collapsed;
}

function convertTools(tools: Tool[] | undefined): any[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((t) => {
				const params = t.parameters as any;
				return {
					name: t.name,
					description: t.description,
					parameters: {
						type: "OBJECT",
						properties: params?.properties || {},
						required: params?.required || [],
					},
				};
			}),
		},
	];
}

async function getAccessToken() {
	try {
		const credsStr = await readFile(`${homedir()}/.gemini/oauth_creds.json`, "utf8");
		const creds = JSON.parse(credsStr);
		const res = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_id: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
				client_secret: "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",
				grant_type: "refresh_token",
				refresh_token: creds.refresh_token,
			}),
		});
		if (!res.ok) {
			throw new Error(`OAuth refresh failed: ${await res.text()}`);
		}
		const data = (await res.json()) as any;
		return data.access_token;
	} catch (e: any) {
		throw new Error(`Failed to read/refresh Gemini credentials: ${e.message}. Please run 'gemini auth login' first.`);
	}
}

async function discoverProject(token: string): Promise<string> {
	const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": "google-api-nodejs-client/9.15.1",
		},
		body: JSON.stringify({
			cloudaicompanionProject: envProjectId,
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
				duetProject: envProjectId,
			},
		}),
	});
	if (!res.ok) {
		if (envProjectId) return envProjectId;
		throw new Error(`Failed to load Cloud Code Assist profile: ${await res.text()}`);
	}
	const data = (await res.json()) as any;
	if (data.cloudaicompanionProject) {
		return typeof data.cloudaicompanionProject === "string"
			? data.cloudaicompanionProject
			: data.cloudaicompanionProject.id || data.cloudaicompanionProject;
	}
	if (envProjectId) return envProjectId;
	throw new Error("No Cloud Code Assist project found. Please set GOOGLE_CLOUD_PROJECT.");
}

let toolCallCounter = 0;

function streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const token = await getAccessToken();
			const projectId = await discoverProject(token);

			const contents = convertMessages(context.messages, true);
			const tools = convertTools(context.tools);

			const systemInstruction = context.systemPrompt
				? {
						role: "user",
						parts: [{ text: sanitizeSurrogates(context.systemPrompt) }],
					}
				: undefined;

			const body: Record<string, any> = {
				model: model.id,
				project: projectId,
				user_prompt_id: `prompt-${Date.now()}`,
				request: {
					contents,
					generationConfig: {
						temperature: options?.temperature ?? 0,
						maxOutputTokens: options?.maxTokens,
					},
				},
			};

			if (systemInstruction) body.request.systemInstruction = systemInstruction;
			if (tools) body.request.tools = tools;

			// Ensure we request the correct endpoint for Cloud Code Assist
			const endpoint = `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`;

			const res = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					"User-Agent":
						"CloudCodeVSCode/0.49.0 (aidev_client; os_type=macOS; os_version=24.6.0; arch=arm64; host_path=VSCode/unknown; proxy_client=geminicli)",
					"X-Goog-Api-Client": "gl-node/22.17.0",
					"Client-Metadata": JSON.stringify({
						ideType: "VSCODE",
						platform: "MAC_OS",
						pluginType: "GEMINI",
					}),
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			if (!res.ok) {
				throw new Error(`Gemini CLI API error: ${res.status} ${res.statusText}\n${await res.text()}`);
			}

			stream.push({ type: "start", partial: output });

			const reader = res.body?.getReader();
			if (!reader) throw new Error("No response body");

			const decoder = new TextDecoder();
			let buffer = "";
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const dataStr = line.slice(6).trim();
					if (!dataStr || dataStr === "[DONE]") continue;

					try {
						const chunk = JSON.parse(dataStr) as unknown;
						if (typeof chunk !== "object" || chunk === null) continue;
						const chunkObj = chunk as Record<string, unknown>;
						const responseData = (chunkObj.response ?? chunkObj) as Record<string, unknown>;
						const candidates = responseData.candidates as unknown[];
						const candidate = (Array.isArray(candidates) ? candidates[0] : undefined) as
							| Record<string, unknown>
							| undefined;

						if (candidate?.content && typeof candidate.content === "object") {
							const content = candidate.content as Record<string, unknown>;
							const parts = content.parts as unknown[];
							if (Array.isArray(parts)) {
								for (const part of parts) {
									const p = part as Record<string, unknown>;
									if (p.text !== undefined) {
										const isThinking = isThinkingPart(p);
										if (
											!currentBlock ||
											(isThinking && currentBlock.type !== "thinking") ||
											(!isThinking && currentBlock.type !== "text")
										) {
											if (currentBlock) {
												if (currentBlock.type === "text") {
													stream.push({
														type: "text_end",
														contentIndex: blockIndex(),
														content: currentBlock.text,
														partial: output,
													});
												} else {
													stream.push({
														type: "thinking_end",
														contentIndex: blockIndex(),
														content: currentBlock.thinking,
														partial: output,
													});
												}
											}
											if (isThinking) {
												currentBlock = {
													type: "thinking",
													thinking: "",
													thinkingSignature: undefined,
												};
												output.content.push(currentBlock);
												stream.push({
													type: "thinking_start",
													contentIndex: blockIndex(),
													partial: output,
												});
											} else {
												currentBlock = { type: "text", text: "" };
												output.content.push(currentBlock);
												stream.push({
													type: "text_start",
													contentIndex: blockIndex(),
													partial: output,
												});
											}
										}
										if (currentBlock.type === "thinking") {
											currentBlock.thinking += p.text;
											currentBlock.thinkingSignature = retainThoughtSignature(
												currentBlock.thinkingSignature,
												p.thoughtSignature as string | undefined,
											);
											stream.push({
												type: "thinking_delta",
												contentIndex: blockIndex(),
												delta: p.text as string,
												partial: output,
											});
										} else {
											currentBlock.text += p.text;
											currentBlock.textSignature = retainThoughtSignature(
												currentBlock.textSignature,
												p.thoughtSignature as string | undefined,
											);
											stream.push({
												type: "text_delta",
												contentIndex: blockIndex(),
												delta: p.text as string,
												partial: output,
											});
										}
									}

									if (p.functionCall) {
										const fc = p.functionCall as Record<string, unknown>;
										if (currentBlock) {
											if (currentBlock.type === "text") {
												stream.push({
													type: "text_end",
													contentIndex: blockIndex(),
													content: currentBlock.text,
													partial: output,
												});
											} else {
												stream.push({
													type: "thinking_end",
													contentIndex: blockIndex(),
													content: currentBlock.thinking,
													partial: output,
												});
											}
											currentBlock = null;
										}

										const toolCallId = `${fc.name}_${Date.now()}_${++toolCallCounter}`;
										const toolCall: ToolCall = {
											type: "toolCall",
											id: toolCallId,
											name: (fc.name as string) || "",
											arguments: (fc.args as Record<string, unknown>) ?? {},
										};
										if (p.thoughtSignature) {
											toolCall.thoughtSignature = p.thoughtSignature as string;
										}

										output.content.push(toolCall);
										stream.push({
											type: "toolcall_start",
											contentIndex: blockIndex(),
											partial: output,
										});
										stream.push({
											type: "toolcall_end",
											contentIndex: blockIndex(),
											toolCall,
											partial: output,
										});
									}
								}
							}
						}
					} catch (_e) {
						// Ignore parse errors for incomplete chunks if any
					}
				}
			}

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error: any) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error.message;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("gemini-cli", {
		api: "gemini-cli-api",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		apiKey: "dummy",
		models: [
			{
				id: "gemini-3.5-flash",
				name: "Gemini 3.5 Flash (CLI)",
				reasoning: true,
				contextWindow: 1048576,
				maxTokens: 65536,
				input: ["text"],
				cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
			},
			{
				id: "gemini-3.1-pro-preview",
				name: "Gemini 3.1 Pro (CLI)",
				reasoning: true,
				contextWindow: 1048576,
				maxTokens: 65536,
				input: ["text"],
				cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
			},
			{
				id: "gemini-3.1-flash-lite-preview",
				name: "Gemini 3.1 Flash Lite Preview (CLI)",
				reasoning: true,
				contextWindow: 1048576,
				maxTokens: 65536,
				input: ["text"],
				cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
			},
		],
		streamSimple,
	});
}
