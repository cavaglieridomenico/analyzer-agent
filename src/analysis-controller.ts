// analysis-controller.ts
import fs from "fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

// --- AI/API Configuration ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
//const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- 1. API HELPER (To handle 503 errors and timeouts) ---
async function makeApiCall(prompt: string) {
  let attempts = 0;
  const maxRetries = 3;
  const timeout = 30000; // 30 seconds

  while (attempts < maxRetries) {
    try {
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("API call timed out")), timeout)
        ),
      ]);
      // The type assertion is needed because Promise.race returns a generic Promise
      return result as Awaited<ReturnType<typeof model.generateContent>>;
    } catch (error: any) {
      if (
        error.message === "API call timed out" ||
        error.status === 503 ||
        (error.message && error.message.includes("503"))
      ) {
        attempts++;
        const delay = Math.pow(2, attempts) * 1000;
        console.warn(
          `API call failed (${error.message}). Retrying in ${delay / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error("A non-retryable API error occurred:", error);
        throw error;
      }
    }
  }
  const finalError = new Error("API call failed after multiple retries.");
  console.error(finalError.message);
  throw finalError;
}

// --- 2. LOCAL ANALYZER (Refined to add child event context) ---
function findWorstBottleneck(traceData: { traceEvents: any[] }) {
  console.log(
    "[SERVER]: Analyzing trace locally to find the worst bottleneck..."
  );

  const longTasks = traceData.traceEvents.filter(
    (event) =>
      event.ph === "X" && // 'X' denotes a complete event with a duration
      event.dur > 50000 && // duration is in microseconds (50ms = 50,000µs)
      event.cat &&
      event.cat.includes("devtools.timeline")
  );

  if (longTasks.length === 0) {
    return { summary: "No tasks over 50ms were found in the trace." };
  }

  const worstTask = longTasks.reduce(
    (max, task) => (task.dur > max.dur ? task : max),
    longTasks[0]
  );

  // Find child events to populate the 'details'
  const taskStartTime = worstTask.ts;
  const taskEndTime = worstTask.ts + worstTask.dur;
  const childEvents = traceData.traceEvents
    .filter(
      (event) =>
        event.ts >= taskStartTime &&
        event.ts < taskEndTime &&
        event.pid === worstTask.pid &&
        event.tid === worstTask.tid &&
        event !== worstTask // Exclude the task itself
    )
    .map((e) => ({
      name: e.name,
      dur_ms: e.dur / 1000,
      category: e.cat,
      details: e.args,
    }));

  return {
    description: "Found the single longest task and its direct children.",
    eventName: worstTask.name,
    category: worstTask.cat,
    startTime_ms: worstTask.ts / 1000,
    duration_ms: worstTask.dur / 1000,
    details: {
      original_args: worstTask.args,
      childEvents: childEvents.slice(0, 15), // Include top 15 children for context
    },
  };
}

// --- 3. AI ANALYZER (Sends bottleneck to Gemini) ---
async function getAnalysis(bottleneck: any) {
  console.log("[SERVER]: Sending bottleneck to Gemini for expert analysis...");
  const prompt = `
    You are an expert web performance analyst. I have captured a performance trace and
    identified the single worst bottleneck, including its direct child events.

    Analyze the following JSON object which describes this task:
    ${JSON.stringify(bottleneck, null, 2)}

    Provide a report in markdown format with the following sections:
    1.  **Root Cause Analysis:** Based on the main task (eventName: "${
      bottleneck.eventName
    }") and the context from its 'childEvents', what is the specific cause of this ${
    bottleneck.duration_ms
  }ms bottleneck?
    2.  **Actionable Solution:** Provide a specific code improvement or strategy to fix this. Reference the child events in your explanation.
    `;

  const result = await makeApiCall(prompt);
  return result.response.text();
}

// --- 4. MAIN FUNCTION (Ties it all together) ---
/**
 * Reads the trace file, finds the worst bottleneck,
 * and sends it to Gemini for analysis.
 */
export async function analyzeTraceFile(): Promise<string> {
  // 1. Read the trace file
  console.log("[SERVER]: Reading trace.json file...");
  const traceFile = await fs.readFile("trace.json", "utf8");
  const traceData = JSON.parse(traceFile);

  // 2. Find the worst bottleneck LOCALLY
  const bottleneck = findWorstBottleneck(traceData);

  // 3. Send that bottleneck to Gemini for expert analysis
  const analysisReport = await getAnalysis(bottleneck);

  return analysisReport;
}
