/**
 * One-time setup: creates a persistent Browserbase context and saves your
 * ClassPass login so bookClass never needs to log in.
 *
 * Usage:
 *   npx tsx setup-classpass.ts
 *
 * Requires these env vars in your shell:
 *   BROWSERBASE_API_KEY
 *   BROWSERBASE_PROJECT_ID
 *   ANTHROPIC_API_KEY
 */

import "dotenv/config";
import { Stagehand } from "@browserbasehq/stagehand";
import * as readline from "readline";

async function main() {
	const apiKey = process.env.BROWSERBASE_API_KEY;
	const projectId = process.env.BROWSERBASE_PROJECT_ID;
	const anthropicKey = process.env.ANTHROPIC_API_KEY;

	if (!apiKey || !projectId || !anthropicKey) {
		console.error("Missing env vars. Set BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, ANTHROPIC_API_KEY in your shell first.");
		process.exit(1);
	}

	// 1. Create a fresh persistent Browserbase context
	console.log("Creating Browserbase context...");
	const ctxRes = await fetch("https://api.browserbase.com/v1/contexts", {
		method: "POST",
		headers: { "X-BB-Api-Key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ projectId }),
	});

	if (!ctxRes.ok) {
		console.error(`Failed to create context: ${ctxRes.status} ${await ctxRes.text()}`);
		process.exit(1);
	}

	const { id: contextId } = await ctxRes.json();
	console.log(`Context created: ${contextId}`);

	// 2. Start a Stagehand session that uses this context with persist:true
	const stagehand = new Stagehand({
		env: "BROWSERBASE",
		apiKey,
		projectId,
		browserbaseSessionCreateParams: {
			browserSettings: { context: { id: contextId, persist: true } },
		},
		model: { modelName: "anthropic/claude-sonnet-4-6", apiKey: anthropicKey },
		verbose: 0,
	});

	await stagehand.init();

	// 3. Navigate to ClassPass login
	await stagehand.context.activePage()?.goto("https://www.classpass.com/login", {
		waitUntil: "domcontentloaded",
	});

	// 4. Print the live-view URL so the user can log in manually
	console.log("\n─────────────────────────────────────────────────────");
	console.log("Open this URL in your browser and log into ClassPass:");
	console.log(`\nhttps://www.browserbase.com/sessions/${stagehand.browserbaseSessionID}\n`);
	console.log("After you've finished logging in, come back here and press Enter.");
	console.log("─────────────────────────────────────────────────────\n");

	// 5. Wait for user to finish logging in
	await new Promise<void>((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question("Press Enter when you're logged in... ", () => {
			rl.close();
			resolve();
		});
	});

	// 6. Close — cookies are persisted into the Browserbase Context
	await stagehand.close({ force: true });

	console.log("\n✓ Session saved.\n");
	console.log("Run this command to wire the context into the worker:\n");
	console.log(`  ntn workers env set BROWSERBASE_CONTEXT_ID=${contextId}\n`);
	console.log("Then redeploy: ntn workers deploy");
}

main().catch((err) => { console.error(err); process.exit(1); });
