# Performance Analysis Agent

This project is a Node.js-based agent that uses Puppeteer to connect to a live browser instance and analyze web performance. It provides API endpoints to start and stop performance traces and to trigger an AI-powered analysis of the captured trace data.

## How to Use

To use the agent, you will need two terminals running in the project's root directory.

### Terminal 1: Start the Agent Server

This terminal runs the main Express server, which listens for commands.

```bash
npm start
```

The server will start and listen for requests on the configured port.

### Terminal 2: Control the Agent

This terminal is used to send commands to the agent to control the browser and the analysis workflow.

1.  **Start Tracing:**
    This will begin recording a performance trace of the active browser tab.
    ```bash
    npm run trace:start
    ```

2.  **Stop Tracing:**
    This will stop the recording and save the trace data to a `trace.json` file.
    ```bash
    npm run trace:stop
    ```

3.  **Analyze the Trace:**
    This will read the `trace.json` file, find the worst performance bottleneck, and send it to an AI for analysis. The results will be saved in `analysis-report.md`.
    ```bash
    npm run trace:analyze
    ```

### Important Notes

*   Ensure you have a `.env` file in the root directory with your `GEMINI_API_KEY`.
*   The agent uses a headless Chrome browser by default. This can be configured in `src/browser-controller.ts`.
*   The analysis focuses on identifying the longest-running tasks on the main thread to diagnose UI freezes and high Interaction to Next Paint (INP).
