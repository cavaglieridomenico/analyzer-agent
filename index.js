/**
 * Main entry point for the persistent agent application.
 */

const PersistentAgent = require('./browser-controller');
const createServer = require('./agent-server');

// Create a new instance of the agent
const agent = new PersistentAgent();

// Launch the browser and, upon success, start the API server
agent.launch()
    .then(() => {
        createServer(agent);
    })
    .catch(console.error);

