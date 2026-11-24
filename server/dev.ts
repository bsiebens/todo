// `npm run dev:server`: the sync server for local development, with Postgres running
// in-process (PGlite), so no database needs to be installed. Data is kept in .dev-data/.
// Not used in production; the Docker image runs server/main.ts against real Postgres.
process.env.TODO_DEV = '1';
process.env.STATIC_DIR ??= 'dist';

(async () => {
  // Imported after TODO_DEV is set, so main.ts does not start its production entry.
  const { testDb } = await import('./testing');
  const { run } = await import('./main');
  const appUrl = process.env.APP_URL?.trim() || 'http://localhost:5173';
  await run(await testDb('.dev-data'), appUrl);
  console.log(`Dev sync server ready. Run \`npm run dev\` in another terminal and open ${appUrl}.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
