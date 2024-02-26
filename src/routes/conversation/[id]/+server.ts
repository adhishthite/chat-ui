import { MESSAGES_BEFORE_LOGIN, RATE_LIMIT } from "$env/static/private";
import { authCondition, requiresUser } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { models } from "$lib/server/models";
import { ERROR_MESSAGES } from "$lib/stores/errors";
import type { Message } from "$lib/types/Message";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import { runWebSearch } from "$lib/server/websearch/runWebSearch";
import type { WebSearch } from "$lib/types/WebSearch";
import { abortedGenerations } from "$lib/server/abortedGenerations";
import { summarize } from "$lib/server/summarize";
import { uploadFile } from "$lib/server/files/uploadFile";
import sizeof from "image-size";
import type { Assistant } from "$lib/types/Assistant";

export async function POST({ request, locals, params, getClientAddress }) {
	const id = z.string().parse(params.id);
	const convId = new ObjectId(id);
	const promptedAt = new Date();

	const userId = locals.user?._id ?? locals.sessionId;

	// check user
	if (!userId) {
		throw error(401, "Unauthorized");
	}

	// check if the user has access to the conversation
	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		throw error(404, "Conversation not found");
	}

	// register the event for ratelimiting
	await collections.messageEvents.insertOne({
		userId,
		createdAt: new Date(),
		ip: getClientAddress(),
	});

	// guest mode check
	if (
		!locals.user?._id &&
		requiresUser &&
		(MESSAGES_BEFORE_LOGIN ? parseInt(MESSAGES_BEFORE_LOGIN) : 0) > 0
	) {
		const totalMessages =
			(
				await collections.conversations
					.aggregate([
						{ $match: authCondition(locals) },
						{ $project: { messages: 1 } },
						{ $unwind: "$messages" },
						{ $match: { "messages.from": "assistant" } },
						{ $count: "messages" },
					])
					.toArray()
			)[0]?.messages ?? 0;

		if (totalMessages > parseInt(MESSAGES_BEFORE_LOGIN)) {
			throw error(429, "Exceeded number of messages before login");
		}
	}

	// check if the user is rate limited
	const nEvents = Math.max(
		await collections.messageEvents.countDocuments({ userId }),
		await collections.messageEvents.countDocuments({ ip: getClientAddress() })
	);

	if (RATE_LIMIT != "" && nEvents > parseInt(RATE_LIMIT)) {
		throw error(429, ERROR_MESSAGES.rateLimited);
	}

	// fetch the model
	const model = models.find((m) => m.id === conv.model);

	if (!model) {
		throw error(410, "Model not available anymore");
	}

	// finally parse the content of the request
	const json = await request.json();

	const {
		inputs: newPrompt,
		id: messageId,
		is_retry: isRetry,
		is_continue: isContinue,
		web_search: webSearch,
		files: b64files,
	} = z
		.object({
			inputs: z.optional(z.string().trim().min(1)),
			id: z.optional(z.string().uuid()),
			is_retry: z.optional(z.boolean()),
			is_continue: z.optional(z.boolean()),
			web_search: z.optional(z.boolean()),
			files: z.optional(z.array(z.string())),
		})
		.parse(json);

	// files is an array of base64 strings encoding Blob objects
	// we need to convert this array to an array of File objects

	const files = b64files?.map((file) => {
		const blob = Buffer.from(file, "base64");
		return new File([blob], "image.png");
	});

	// check sizes
	if (files) {
		const filechecks = await Promise.all(
			files.map(async (file) => {
				const dimensions = sizeof(Buffer.from(await file.arrayBuffer()));
				return (
					file.size > 2 * 1024 * 1024 ||
					(dimensions.width ?? 0) > 224 ||
					(dimensions.height ?? 0) > 224
				);
			})
		);

		if (filechecks.some((check) => check)) {
			throw error(413, "File too large, should be <2MB and 224x224 max.");
		}
	}

	let hashes: undefined | string[];

	if (files) {
		hashes = await Promise.all(files.map(async (file) => await uploadFile(file, conv)));
	}

	// can only call isContinue on the last message id
	if (isContinue && conv.messages[conv.messages.length - 1].id !== messageId) {
		throw error(400, "Can only continue the last message");
	}

	// get the list of messages
	// while checking for retries
	let messages = (() => {
		// for retries we slice and rewrite the last user message
		if (isRetry && messageId) {
			// if the message is a retry, replace the message and remove the messages after it
			let retryMessageIdx = conv.messages.findIndex((message) => message.id === messageId);

			if (retryMessageIdx === -1) {
				retryMessageIdx = conv.messages.length;
			}

			return [
				...conv.messages.slice(0, retryMessageIdx),
				{
					content: conv.messages[retryMessageIdx]?.content,
					from: "user",
					id: messageId as Message["id"],
					updatedAt: new Date(),
					files: conv.messages[retryMessageIdx]?.files,
				},
			];
		} else if (isContinue && messageId) {
			// for continue we do nothing and expand the last assistant message
			return conv.messages;
		} else {
			// in normal conversation we add an extra user message
			return [
				...conv.messages,
				{
					content: newPrompt ?? "",
					from: "user",
					id: (messageId as Message["id"]) || crypto.randomUUID(),
					createdAt: new Date(),
					updatedAt: new Date(),
					files: hashes,
				},
			];
		} // else append the message at the bottom
	})() satisfies Message[];

	await collections.conversations.updateOne(
		{
			_id: convId,
		},
		{
			$set: {
				messages,
				title: conv.title,
				updatedAt: new Date(),
			},
		}
	);

	let doneStreaming = false;

	// we now build the stream
	const stream = new ReadableStream({
		async start(controller) {
			const updates: MessageUpdate[] = isContinue
				? conv.messages[conv.messages.length - 1].updates ?? []
				: [];

			function update(newUpdate: MessageUpdate) {
				if (newUpdate.type !== "stream") {
					updates.push(newUpdate);
				}

				if (newUpdate.type === "stream" && newUpdate.token === "") {
					return;
				}
				controller.enqueue(JSON.stringify(newUpdate) + "\n");

				if (newUpdate.type === "finalAnswer") {
					// 4096 of spaces to make sure the browser doesn't blocking buffer that holding the response
					controller.enqueue(" ".repeat(4096));
				}
			}

			update({ type: "status", status: "started" });

			const summarizeIfNeeded = (async () => {
				if (conv.title === "New Chat" && messages.length === 1) {
					try {
						conv.title = (await summarize(messages[0].content)) ?? conv.title;
						update({ type: "status", status: "title", message: conv.title });
					} catch (e) {
						console.error(e);
					}
				}
			})();

			await collections.conversations.updateOne(
				{
					_id: convId,
				},
				{
					$set: {
						messages,
						title: conv.title,
						updatedAt: new Date(),
					},
				}
			);

			let webSearchResults: WebSearch | undefined;

			// check if assistant has a rag
			const rag =
				(
					await collections.assistants.findOne<Pick<Assistant, "rag">>(
						{ _id: conv.assistantId },
						{ projection: { rag: 1 } }
					)
				)?.rag ?? undefined;

			const assistantHasRAG =
				rag &&
				(rag.allowedLinks.length > 0 || rag.allowedDomains.length > 0 || rag.allowAllDomains);

			// if websearch is enabled and the assistant is not specified or it is and has a rag
			if (!isContinue && ((webSearch && !conv.assistantId) || assistantHasRAG)) {
				webSearchResults = await runWebSearch(
					conv,
					messages[messages.length - 1].content,
					update,
					rag
				);
				messages[messages.length - 1].webSearch = webSearchResults;
			} else if (isContinue) {
				webSearchResults = messages[messages.length - 1].webSearch;
			}
			conv.messages = messages;

			const previousContent = isContinue
				? conv.messages.find((message) => message.id === messageId)?.content ?? ""
				: "";

			try {
				const endpoint = await model.getEndpoint();
				for await (const output of await endpoint({ conversation: conv, continue: isContinue })) {
					// if not generated_text is here it means the generation is not done
					if (!output.generated_text) {
						// else we get the next token
						if (!output.token.special) {
							update({
								type: "stream",
								token: output.token.text,
							});

							// if the last message is not from assistant, it means this is the first token
							const lastMessage = messages[messages.length - 1];

							if (lastMessage?.from !== "assistant") {
								// so we create a new message
								messages = [
									...messages,
									// id doesn't match the backend id but it's not important for assistant messages
									// First token has a space at the beginning, trim it
									{
										from: "assistant",
										content: output.token.text.trimStart(),
										webSearch: webSearchResults,
										updates,
										id: crypto.randomUUID(),
										createdAt: new Date(),
										updatedAt: new Date(),
									},
								];
							} else {
								// abort check
								const date = abortedGenerations.get(convId.toString());
								if (date && date > promptedAt) {
									break;
								}

								if (!output) {
									break;
								}

								// otherwise we just concatenate tokens
								lastMessage.content += output.token.text;
							}
						}
					} else {
						let interrupted = !output.token.special;
						// add output.generated text to the last message
						// strip end tokens from the output.generated_text
						const text = (model.parameters.stop ?? []).reduce((acc: string, curr: string) => {
							if (acc.endsWith(curr)) {
								interrupted = false;
								return acc.slice(0, acc.length - curr.length);
							}
							return acc;
						}, output.generated_text.trimEnd());

						messages = [
							...messages.slice(0, -1),
							{
								...messages[messages.length - 1],
								content: previousContent + text,
								interrupted, // if its a special token it finished on its own, else it was interrupted
								updates,
								updatedAt: new Date(),
							},
						];
					}
				}
			} catch (e) {
				update({ type: "status", status: "error", message: (e as Error).message });
			}

			await collections.conversations.updateOne(
				{
					_id: convId,
				},
				{
					$set: {
						messages,
						title: conv?.title,
						updatedAt: new Date(),
					},
				}
			);

			// used to detect if cancel() is called bc of interrupt or just because the connection closes
			doneStreaming = true;

			update({
				type: "finalAnswer",
				text: messages[messages.length - 1].content,
			});

			await summarizeIfNeeded;
			controller.close();
			return;
		},
		async cancel() {
			if (!doneStreaming) {
				await collections.conversations.updateOne(
					{
						_id: convId,
					},
					{
						$set: {
							messages,
							title: conv.title,
							updatedAt: new Date(),
						},
					}
				);
			}
		},
	});

	// Todo: maybe we should wait for the message to be saved before ending the response - in case of errors
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
		},
	});
}

export async function DELETE({ locals, params }) {
	const convId = new ObjectId(params.id);

	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		throw error(404, "Conversation not found");
	}

	await collections.conversations.deleteOne({ _id: conv._id });

	return new Response();
}

export async function PATCH({ request, locals, params }) {
	const { title } = z
		.object({ title: z.string().trim().min(1).max(100) })
		.parse(await request.json());

	const convId = new ObjectId(params.id);

	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		throw error(404, "Conversation not found");
	}

	await collections.conversations.updateOne(
		{
			_id: convId,
		},
		{
			$set: {
				title,
			},
		}
	);

	return new Response();
}
