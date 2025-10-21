import express, { Express, Request, Response } from "express";
import fs from "fs/promises";
import PersistentAgent from "./browser-controller";
import { analyzeTraceFile } from "./analysis-controller";

/**
 * Creates and configures an Express server to expose the agent's capabilities via an API.
 * @param {PersistentAgent} agent - An instance of the PersistentAgent.
 * @returns {object} The configured Express app.
 */
function createServer(agent: PersistentAgent): Express {
  const app: Express = express();
  app.use(express.json());
  const port = 3000;

  // Endpoint to start a performance trace
  app.post("/trace/start", async (req: Request, res: Response) => {
    try {
      await agent.startTrace();
      res.send({ message: `Performance trace started` });
    } catch (error) {
      console.error(error);
      res.status(500).send({ error: "Failed to start trace" });
    }
  });

  // Endpoint to stop a performance trace
  app.post("/trace/stop", async (req: Request, res: Response) => {
    try {
      await agent.stopTrace();
      res.send({ message: "Performance trace stopped" });
    } catch (error) {
      console.error(error);
      res.status(500).send({ error: "Failed to stop trace" });
    }
  });

  // Endpoint to navigate the agent's page
  app.post("/navigate", async (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url) {
      return res.status(400).send({ error: "URL is required" });
    }
    try {
      await agent.navigate(url);
      res.send({ message: `Navigation to ${url} complete` });
    } catch (error) {
      console.error(error);
      res.status(500).send({ error: "Failed to navigate" });
    }
  });

  // Endpoint to analyze the trace file
  app.post("/trace/analyze", async (req: Request, res: Response) => {
    try {
      const analysisReport = await analyzeTraceFile();
      const reportPath = "analysis-report.md";
      await fs.writeFile(reportPath, analysisReport);
      console.log(`Analysis report saved to ${reportPath}`);
      res.send({
        message: `Analysis complete`,
      });
    } catch (error) {
      console.error(error);
      res.status(500).send({ error: "Failed to analyze trace" });
    }
  });

  // Start the server
  app.listen(port, () => {
    console.log(`Agent API listening at http://localhost:${port}`);
  });

  return app;
}

export default createServer;
