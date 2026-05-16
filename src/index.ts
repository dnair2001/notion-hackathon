import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// --- OAuth ---

const stravaAuth = worker.oauth("stravaAuth", {
	name: "strava-oauth",
	authorizationEndpoint: "https://www.strava.com/oauth/authorize",
	tokenEndpoint: "https://www.strava.com/oauth/token",
	scope: "activity:read_all",
	clientId: process.env.STRAVA_CLIENT_ID ?? "",
	clientSecret: process.env.STRAVA_CLIENT_SECRET ?? "",
	authorizationParams: {
		approval_prompt: "force", // required by Strava to issue a refresh token
	},
});

// --- Databases ---

const activities = worker.database("activities", {
	type: "managed",
	initialTitle: "🏃 Strava Activities",
	primaryKeyProperty: "Activity ID",
	schema: {
		properties: {
			Name: Schema.title(),
			"Activity ID": Schema.richText(),
			Type: Schema.select([
				{ name: "Run", color: "blue" },
				{ name: "Ride", color: "orange" },
				{ name: "Swim", color: "blue" },
				{ name: "WeightTraining", color: "red" },
				{ name: "Yoga", color: "purple" },
				{ name: "Workout", color: "green" },
				{ name: "Walk", color: "yellow" },
				{ name: "Hike", color: "green" },
				{ name: "Other", color: "gray" },
			]),
			Date: Schema.date(),
			"Duration (min)": Schema.number(),
			"Distance (km)": Schema.number(),
		},
	},
});

const recommendations = worker.database("recommendations", {
	type: "managed",
	initialTitle: "🏋️ Class Recommendations",
	primaryKeyProperty: "Class ID",
	schema: {
		properties: {
			Name: Schema.title(),
			"Class ID": Schema.richText(),
			Description: Schema.richText(),
			"Class Type": Schema.select([
				{ name: "Yoga", color: "purple" },
				{ name: "HIIT", color: "red" },
				{ name: "Spin", color: "orange" },
				{ name: "Pilates", color: "pink" },
				{ name: "Boxing", color: "gray" },
				{ name: "Dance", color: "yellow" },
				{ name: "Strength", color: "blue" },
				{ name: "Barre", color: "pink" },
				{ name: "CrossFit", color: "red" },
				{ name: "Other", color: "gray" },
			]),
			URL: Schema.url(),
			"Mindbody Class ID": Schema.richText(),
			"Mindbody Site ID": Schema.richText(),
			Status: Schema.select([
				{ name: "Available", color: "green" },
				{ name: "Booked", color: "blue" },
			]),
		},
	},
});

// --- Pacers ---

// Strava rate limit: 100 requests per 15 minutes, 1000 per day
const stravaApi = worker.pacer("stravaApi", { allowedRequests: 100, intervalMs: 900_000 });

// Firecrawl: conservative pacing to stay within free tier
const firecrawlApi = worker.pacer("firecrawlApi", { allowedRequests: 2, intervalMs: 1_000 });

// Mindbody: 1000 req/day, spread conservatively
const mindbodyApi = worker.pacer("mindbodyApi", { allowedRequests: 10, intervalMs: 60_000 });

// --- Helpers ---

const SPORT_TYPE_MAP: Record<string, string> = {
	Run: "Run", TrailRun: "Run", VirtualRun: "Run",
	Ride: "Ride", VirtualRide: "Ride", EBikeRide: "Ride",
	Swim: "Swim",
	WeightTraining: "WeightTraining",
	Yoga: "Yoga",
	Workout: "Workout", Crossfit: "Workout", HIITWorkout: "Workout",
	Walk: "Walk",
	Hike: "Hike",
};

const CLASS_TYPE_MAP: Record<string, string> = {
	yoga: "Yoga",
	hiit: "HIIT",
	spin: "Spin",
	spinning: "Spin",
	pilates: "Pilates",
	boxing: "Boxing",
	dance: "Dance",
	strength: "Strength",
	barre: "Barre",
	crossfit: "CrossFit",
};

function formatClassType(raw: string): string {
	const key = raw.toLowerCase().trim();
	return CLASS_TYPE_MAP[key] ?? (key.charAt(0).toUpperCase() + key.slice(1));
}

function weekStartTimestamp(): number {
	const d = new Date();
	d.setDate(d.getDate() - d.getDay()); // rewind to Sunday
	d.setHours(0, 0, 0, 0);
	return Math.floor(d.getTime() / 1000);
}

// --- Mindbody helpers ---

const MINDBODY_BASE = "https://api.mindbodyonline.com/public/v6";

async function mindbodyGetClasses(apiKey: string, siteId: string): Promise<any[]> {
	const start = new Date().toISOString();
	const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
	const res = await fetch(
		`${MINDBODY_BASE}/class/classes?StartDateTime=${encodeURIComponent(start)}&EndDateTime=${encodeURIComponent(end)}&HideCanceledClasses=true`,
		{ headers: { "Api-Key": apiKey, "SiteId": siteId } },
	);
	if (!res.ok) {
		console.warn(`Mindbody classes fetch failed for site ${siteId}: ${res.status}`);
		return [];
	}
	const data = await res.json();
	return data.Classes ?? [];
}

async function mindbodyIssueToken(apiKey: string, siteId: string, username: string, password: string): Promise<string> {
	const res = await fetch(`${MINDBODY_BASE}/usertoken/issue`, {
		method: "POST",
		headers: { "Api-Key": apiKey, "SiteId": siteId, "Content-Type": "application/json" },
		body: JSON.stringify({ Username: username, Password: password }),
	});
	if (!res.ok) throw new Error(`Mindbody auth failed: ${res.status} ${res.statusText}`);
	const data = await res.json();
	return data.AccessToken as string;
}

async function mindbodyGetClientId(apiKey: string, siteId: string, accessToken: string): Promise<string> {
	const res = await fetch(`${MINDBODY_BASE}/client/clients`, {
		headers: { "Api-Key": apiKey, "SiteId": siteId, "Authorization": `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`Mindbody client lookup failed: ${res.status}`);
	const data = await res.json();
	const client = data.Clients?.[0];
	if (!client) throw new Error("No Mindbody client found for these credentials");
	return String(client.UniqueId ?? client.Id);
}

async function mindbodyBookClass(
	apiKey: string, siteId: string, accessToken: string, classId: string, clientId: string,
): Promise<string> {
	const res = await fetch(`${MINDBODY_BASE}/class/addclienttoclass`, {
		method: "POST",
		headers: {
			"Api-Key": apiKey,
			"SiteId": siteId,
			"Authorization": `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ ClassId: Number(classId), ClientId: clientId }),
	});
	const data = await res.json();
	if (!res.ok) {
		const msg = data.Error?.Message ?? data.Message ?? res.statusText;
		throw new Error(`Mindbody booking failed: ${msg}`);
	}
	const cls = data.Class;
	return cls
		? `Booked into ${cls.ClassDescription?.Name ?? "class"} on ${cls.StartDateTime?.split("T")[0] ?? "upcoming date"}`
		: "Booking confirmed by Mindbody";
}

// --- Syncs ---

// Pulls your Strava activities into Notion incrementally, every hour.
// First run fetches the last 30 days; subsequent runs fetch only new activities.
worker.sync("stravaSync", {
	database: activities,
	mode: "incremental",
	schedule: "1h",
	execute: async (state) => {
		const token = await stravaAuth.accessToken();
		const { after } = (state as { after?: number }) ?? {};
		const afterTs = after ?? Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

		await stravaApi.wait();
		const res = await fetch(
			`https://www.strava.com/api/v3/athlete/activities?after=${afterTs}&per_page=100`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!res.ok) throw new Error(`Strava error: ${res.status} ${res.statusText}`);

		const activityList: any[] = await res.json();

		return {
			changes: activityList.map((a) => ({
				type: "upsert" as const,
				key: String(a.id),
				properties: {
					Name: Builder.title(a.name),
					"Activity ID": Builder.richText(String(a.id)),
					Type: Builder.select(SPORT_TYPE_MAP[a.sport_type ?? a.type] ?? "Other"),
					Date: Builder.date(a.start_date.split("T")[0]),
					"Duration (min)": Builder.number(Math.round(a.moving_time / 60)),
					"Distance (km)": Builder.number(
						a.distance ? Math.round(a.distance / 100) / 10 : 0,
					),
				},
			})),
			hasMore: false,
			nextState: { after: Math.floor(Date.now() / 1000) },
		};
	},
});

// Checks this week's activity count against your goal.
// If you're behind, searches the web via Firecrawl and populates recommendations.
// Runs daily. Configure via environment variables:
//   LOCATION          — e.g. "San Francisco, CA"
//   CLASS_TYPES       — comma-separated, e.g. "yoga,HIIT,spin"
//   WEEKLY_GOAL       — number of sessions per week, e.g. "3"
//   FIRECRAWL_API_KEY — from firecrawl.dev
worker.sync("classFinderSync", {
	database: recommendations,
	mode: "replace",
	schedule: "1d",
	execute: async () => {
		const location = process.env.LOCATION ?? "San Francisco, CA";
		const classTypes = (process.env.CLASS_TYPES ?? "yoga,HIIT,spin")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.slice(0, 3);
		const weeklyGoal = parseInt(process.env.WEEKLY_GOAL ?? "3", 10);
		const firecrawlApiKey = process.env.FIRECRAWL_API_KEY ?? "";

		if (!firecrawlApiKey && !process.env.MINDBODY_API_KEY) {
			throw new Error("Set at least one of FIRECRAWL_API_KEY or MINDBODY_API_KEY to find classes.");
		}

		// Count this week's Strava activities
		const token = await stravaAuth.accessToken();
		await stravaApi.wait();
		const weekRes = await fetch(
			`https://www.strava.com/api/v3/athlete/activities?after=${weekStartTimestamp()}&per_page=100`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!weekRes.ok) throw new Error(`Strava error: ${weekRes.status}`);

		const weekActivities: any[] = await weekRes.json();
		const count = weekActivities.length;
		const needed = Math.max(0, weeklyGoal - count);

		console.log(`This week: ${count}/${weeklyGoal} workouts. Need ${needed} more.`);

		if (needed === 0) {
			console.log("Goal achieved — clearing stale recommendations.");
			return { changes: [], hasMore: false };
		}

		const allRecs: {
			id: string;
			name: string;
			type: string;
			description: string;
			url: string;
			mindbodyClassId: string;
			mindbodySiteId: string;
		}[] = [];

		// Pull bookable classes from Mindbody if configured
		const mindbodyApiKey = process.env.MINDBODY_API_KEY ?? "";
		const mindbodySiteIds = (process.env.MINDBODY_SITE_IDS ?? "")
			.split(",").map((s) => s.trim()).filter(Boolean);

		if (mindbodyApiKey && mindbodySiteIds.length > 0) {
			for (const siteId of mindbodySiteIds) {
				await mindbodyApi.wait();
				const classes = await mindbodyGetClasses(mindbodyApiKey, siteId);
				for (const cls of classes) {
					const rawType = cls.ClassDescription?.SessionType?.Name ?? cls.ClassDescription?.Name ?? "";
					const mappedType = formatClassType(rawType);
					if (classTypes.length > 0 && !classTypes.some((t) => rawType.toLowerCase().includes(t.toLowerCase()))) continue;
					const classId = String(cls.Id);
					allRecs.push({
						id: `mb-${siteId}-${classId}`,
						name: cls.ClassDescription?.Name ?? "Class",
						type: mappedType,
						description: cls.ClassDescription?.Description ?? "",
						url: `https://www.mindbodyonline.com/explore/studios/${siteId}`,
						mindbodyClassId: classId,
						mindbodySiteId: siteId,
					});
				}
			}
			console.log(`Found ${allRecs.length} Mindbody classes.`);
		}

		// Fill remaining slots via Firecrawl web search
		if (firecrawlApiKey) {
			for (const classType of classTypes) {
				await firecrawlApi.wait();
				const query = `${classType} classes in ${location} book online this week`;

				const searchRes = await fetch("https://api.firecrawl.dev/v1/search", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${firecrawlApiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ query, limit: 5 }),
				});

				if (!searchRes.ok) {
					console.warn(`Firecrawl error for "${classType}": ${searchRes.status}`);
					continue;
				}

				const { data = [] } = await searchRes.json();

				for (let i = 0; i < data.length; i++) {
					const result = data[i];
					if (!result.url || !result.title) continue;
					allRecs.push({
						id: `fc-${classType}-${i}`,
						name: result.title,
						type: formatClassType(classType),
						description: result.description ?? "",
						url: result.url,
						mindbodyClassId: "",
						mindbodySiteId: "",
					});
				}
			}
		}

		console.log(`Found ${allRecs.length} total recommendations.`);

		return {
			changes: allRecs.map((rec) => ({
				type: "upsert" as const,
				key: rec.id,
				properties: {
					Name: Builder.title(rec.name),
					"Class ID": Builder.richText(rec.id),
					Description: Builder.richText(rec.description),
					"Class Type": Builder.select(rec.type),
					URL: Builder.url(rec.url),
					"Mindbody Class ID": Builder.richText(rec.mindbodyClassId),
					"Mindbody Site ID": Builder.richText(rec.mindbodySiteId),
					Status: Builder.select("Available"),
				},
			})),
			hasMore: false,
		};
	},
});

// --- Tool ---

// Callable by a Notion custom agent — returns this week's workout count vs goal
// and a summary of what's been recommended.
worker.tool("getFitnessStatus", {
	title: "Get My Fitness Status",
	description:
		"Check how many workouts you've completed this week versus your goal. Returns recent activities and whether class recommendations are waiting in Notion.",
	// The Notion agent always injects these three system fields into every tool call.
	schema: j.object({
		name: j.string().nullable(),
		namespace: j.string().nullable(),
		autofixedJson: j.string().nullable(),
	}),
	execute: async () => {
		const weeklyGoal = parseInt(process.env.WEEKLY_GOAL ?? "3", 10);
		const token = await stravaAuth.accessToken();

		const res = await fetch(
			`https://www.strava.com/api/v3/athlete/activities?after=${weekStartTimestamp()}&per_page=100`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!res.ok) throw new Error(`Strava error: ${res.status}`);

		const weekActivities: any[] = await res.json();
		const count = weekActivities.length;
		const needed = Math.max(0, weeklyGoal - count);

		const recent = weekActivities
			.slice(0, 3)
			.map((a) => `• ${a.name} (${Math.round(a.moving_time / 60)} min)`)
			.join("\n");

		if (needed === 0) {
			return [
				`Goal crushed! ${count}/${weeklyGoal} workouts done this week.`,
				recent ? `\nRecent activities:\n${recent}` : "",
			].join("");
		}

		return [
			`You've done ${count}/${weeklyGoal} workouts this week — ${needed} more to go.`,
			recent ? `\nRecent activities:\n${recent}` : "\nNo workouts logged yet this week.",
			"\nCheck your Class Recommendations database in Notion for nearby classes!",
		].join("");
	},
});

// Marks a class from the recommendations database as Booked in Notion.
// Called by the agent when the user picks a class they want to attend.
worker.tool("bookClass", {
	title: "Book a Class",
	description:
		"Mark a fitness class recommendation as Booked in the Notion Class Recommendations database. Use when the user wants to book one of the recommended classes.",
	schema: j.object({
		className: j.string().describe("The name of the class or studio to book, from the recommendations list"),
		name: j.string().nullable(),
		namespace: j.string().nullable(),
		autofixedJson: j.string().nullable(),
	}),
	execute: async ({ className }, { notion }) => {
		// Find the Class Recommendations database by title
		const searchRes = await notion.search({
			query: "Class Recommendations",
			filter: { value: "data_source", property: "object" },
		});

		const db = searchRes.results.find(
			(r: any) => r.object === "data_source" && r.title?.[0]?.plain_text?.includes("Class Recommendations"),
		) as any;

		if (!db) {
			return "Could not find the Class Recommendations database. Make sure classFinderSync has run at least once.";
		}

		// Find the page matching the class name
		const queryRes = await notion.dataSources.query({
			data_source_id: db.id,
			filter: {
				property: "Name",
				title: { contains: className },
			},
		});

		if (queryRes.results.length === 0) {
			return `No class found matching "${className}". Check your Class Recommendations database for the exact name.`;
		}

		const page = queryRes.results[0] as any;
		const pageTitle = page.properties.Name?.title?.[0]?.plain_text ?? className;
		const url = page.properties.URL?.url ?? "";
		const mindbodyClassId = page.properties["Mindbody Class ID"]?.rich_text?.[0]?.plain_text ?? "";
		const mindbodySiteId = page.properties["Mindbody Site ID"]?.rich_text?.[0]?.plain_text ?? "";

		const mindbodyApiKey = process.env.MINDBODY_API_KEY ?? "";
		const mindbodyUsername = process.env.MINDBODY_USERNAME ?? "";
		const mindbodyPassword = process.env.MINDBODY_PASSWORD ?? "";

		let bookingResult = "";
		if (mindbodyClassId && mindbodySiteId && mindbodyApiKey && mindbodyUsername && mindbodyPassword) {
			try {
				await mindbodyApi.wait();
				const token = await mindbodyIssueToken(mindbodyApiKey, mindbodySiteId, mindbodyUsername, mindbodyPassword);
				await mindbodyApi.wait();
				const clientId = await mindbodyGetClientId(mindbodyApiKey, mindbodySiteId, token);
				await mindbodyApi.wait();
				bookingResult = await mindbodyBookClass(mindbodyApiKey, mindbodySiteId, token, mindbodyClassId, clientId);
			} catch (err: any) {
				bookingResult = `Mindbody booking failed: ${err?.message ?? "unknown error"}.${url ? ` Book manually at ${url}.` : ""}`;
			}
		} else if (!mindbodyClassId) {
			bookingResult = url
				? `This studio isn't on Mindbody — book at ${url}.`
				: "This studio isn't on Mindbody and no booking URL is on file.";
		} else {
			bookingResult = "Set MINDBODY_API_KEY, MINDBODY_USERNAME, MINDBODY_PASSWORD in .env to enable real booking.";
		}

		// Update Status to Booked in Notion
		await notion.pages.update({
			page_id: page.id,
			properties: {
				Status: { select: { name: "Booked" } },
			},
		});

		return [
			`"${pageTitle}" is marked as Booked in your Notion recommendations.`,
			bookingResult || (url ? `Complete your booking at: ${url}` : ""),
		].filter(Boolean).join("\n");
	},
});
