import './env.js';
import { app } from './app.js';
import { startPolling } from './poller.js';

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Fieldwatch backend on :${port}`);
  startPolling();
});
