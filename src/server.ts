import { buildServer } from "./app.js";

// Thin entrypoint: the server is assembled in src/app.ts so that tests can
// build an instance and drive it with fastify.inject() without listening on
// a port or starting the process.
async function start() {
  const fastify = await buildServer();
  try {
    await fastify.listen({ port: 3000, host: "0.0.0.0" });
    console.log("Server running at http://localhost:3000");
    console.log("Try: http://localhost:3000/t/w_400,h_300,f_webp/your-image.jpg");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
