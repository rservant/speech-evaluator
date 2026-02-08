// AI Toastmasters Evaluator - Entry point

import "dotenv/config";
import { createAppServer } from "./server.js";

export const APP_NAME = "AI Toastmasters Evaluator";
export const APP_VERSION = "0.1.0";

const port = parseInt(process.env.PORT || "3000", 10);

const server = createAppServer();

server.listen(port).then(() => {
  console.log(`${APP_NAME} v${APP_VERSION} running at http://localhost:${port}`);
});
