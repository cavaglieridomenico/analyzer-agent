import fs from "fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";
import { findWorstBottleneck } from "./utils/trace-analyzer";
import PersistentAgent from "./browser-controller";
import { SourceMapConsumer } from "source-map";
import axios from "axios";

// --- AI/API Configuration ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
//const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- 1. API HELPER (To handle 503 errors and timeouts) ---
async function makeApiCall(prompt: string) {
  let attempts = 0;
  const maxRetries = 3;
  const timeout = 60000; // 60 seconds

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

// --- 2. Source Map Resolver ---
async function resolveSourceLocation(
  sourceMapUrl: string,
  line: number,
  column: number
) {
  console.log(
    `[ANALYZER-DEBUG]: Resolving location for line: ${line}, column: ${column}`
  );
  console.log(
    `[ANALYZER-DEBUG]: Attempting to fetch source map from: ${sourceMapUrl}`
  );
  try {
    const { data: sourceMap } = await axios.get(sourceMapUrl);
    console.log("[ANALYZER-DEBUG]: Source map fetched successfully.");

    const consumer = await new SourceMapConsumer(sourceMap);
    console.log("[ANALYZER-DEBUG]: SourceMapConsumer created.");

    const originalPosition = consumer.originalPositionFor({
      line,
      column,
      bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
    });

    console.log(
      "[ANALYZER-DEBUG]: Result from originalPositionFor:",
      JSON.stringify(originalPosition)
    );

    if (
      originalPosition.source &&
      originalPosition.line != null &&
      originalPosition.column != null
    ) {
      consumer.destroy();
      return originalPosition;
    } else {
      console.warn(
        "[ANALYZER-DEBUG]: originalPositionFor returned nulls. Iterating first 10 mappings for debugging..."
      );
      let count = 0;
      consumer.eachMapping((mapping) => {
        if (count < 10) {
          console.log(
            "[ANALYZER-DEBUG]: Mapping:",
            JSON.stringify({
              source: mapping.source,
              generatedLine: mapping.generatedLine,
              generatedColumn: mapping.generatedColumn,
              originalLine: mapping.originalLine,
              originalColumn: mapping.originalColumn,
              name: mapping.name,
            })
          );
        }
        count++;
      });
      console.log(`[ANALYZER-DEBUG]: Total mappings found: ${count}`);
      consumer.destroy();
      return null;
    }
  } catch (error) {
    console.error(
      `[ANALYZER-ERROR]: Failed during source map processing for ${sourceMapUrl}`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

// --- 3. AI ANALYZER (Sends bottleneck to Gemini) ---
async function getAnalysis(bottleneck: any) {
  console.log("[SERVER]: Sending bottleneck to Gemini for expert analysis...");

  if (bottleneck.summary) {
    return `Analysis skipped: ${bottleneck.summary}`;
  }

  // Create a minimal payload to ensure the request is small
  const promptData = {
    eventName: bottleneck.eventName,
    duration_ms: bottleneck.duration_ms,
    // Use optional chaining for safety, provide a default if null
    originalSourceLocation: bottleneck.originalSourceLocation
      ? `${bottleneck.originalSourceLocation.source}:${bottleneck.originalSourceLocation.line}:${bottleneck.originalSourceLocation.column}`
      : "Source map location not resolved",
  };

  const prompt = `
    You are an expert web performance analyst. I have captured a performance trace and
    identified the single worst bottleneck.

    Analyze the following JSON object which describes this task. The 'originalSourceLocation'
    field contains the exact location in the original source code.

    ${JSON.stringify(promptData, null, 2)}

    Provide a report in markdown format with the following sections:
    1.  **Root Cause Analysis:** Based on the task details, what is happening at **${
      promptData.originalSourceLocation
    }** that is causing a ${promptData.duration_ms}ms bottleneck?
    2.  **Actionable Solution:** Provide a specific code improvement or strategy to fix the issue.
    3.  **Verification:** How can I verify that the fix has worked?
    `;

  const result = await makeApiCall(prompt);
  return result.response.text();
}

// --- 4. MAIN FUNCTION (Ties it all together) ---
/**
 * Reads the trace file, finds the worst bottleneck, resolves its source location,
 * and sends it to Gemini for analysis.
 */
export async function analyzeTraceFile(
  agent: PersistentAgent
): Promise<string> {
  // 1. Read the trace file
  console.log("[SERVER]: Reading trace.json file...");
  const traceFile = await fs.readFile("trace.json", "utf8");
  const traceData = JSON.parse(traceFile);

  // 2. Find the worst bottleneck LOCALLY
  const bottleneck = findWorstBottleneck(traceData);

  // 3. Resolve the source location using the agent
  if (bottleneck.stackFrame) {
    console.log(
      "[SERVER]: Stack frame found. Attempting to resolve source location..."
    );
    const { scriptId, url, lineNumber, columnNumber } = bottleneck.stackFrame;

    // The agent now handles the logic of finding the source map URL
    const fullSourceMapUrl = await agent.getSourceMapUrl(url);

    if (fullSourceMapUrl) {
      console.log(
        `[SERVER]: Agent returned full source map URL: ${fullSourceMapUrl}`
      );

      let originalLocation = await resolveSourceLocation(
        fullSourceMapUrl,
        lineNumber,
        columnNumber
      );

      // If the initial lookup fails, retry with common line numbers for minified files
      if (!originalLocation) {
        console.log(
          "[SERVER]: Initial source map lookup failed. Retrying with common line numbers..."
        );
        for (let i = 1; i <= 5; i++) {
          console.log(`[SERVER]: Retrying with line number: ${i}`);
          originalLocation = await resolveSourceLocation(
            fullSourceMapUrl,
            i, // Use the retry line number
            columnNumber
          );
          if (originalLocation) {
            console.log(
              `[SERVER]: Successfully resolved location on line ${i}.`
            );
            break; // Exit loop on success
          }
        }
      }
      console.log("[SERVER]: Resolved original location:", originalLocation);
      (bottleneck as any).originalSourceLocation = originalLocation;
    } else {
      console.log("[SERVER]: Agent could not resolve the source map URL.");
    }
  } else {
    console.log(
      "[SERVER]: No stack frame found for the bottleneck. Cannot resolve source location."
    );
  }

  // 4. Send that bottleneck to Gemini for expert analysis
  const analysisReport = await getAnalysis(bottleneck);

  return analysisReport;
}
