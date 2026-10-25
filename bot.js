const https = require('https');
const http = require('http');
const { WebSocket } = require('ws');

const CONFIG = {
  appId: process.env.DERIV_APP_ID || '1089',
  token: process.env.DERIV_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
  githubRepo: 'juanfelife1014-art/derivbot-titan47',
  logFile: 'logs/trades.json',
  symbol: 'R_75',
  stake: 1,
  duration: 5,
  durationUnit: 't',
  maxLoss: 20,
  maxWin: 50,
};

let state = {
  balance: 0, currency: 'USD', wins: 0, losses: 0, pnl: 0,
  active: false, contractId: null, candles: [], logs: [],
};

function log(msg, type = 'info') {
  const ts = new Date().toISOString();
  state.logs.unshift({ ts, msg, type });
  if (state.logs.length > 500) state.logs.pop();
  console.log(`[${ts}][${type.toUpperCase()}] ${msg}`);
}

// HTTP server para Render health check
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'running', balance: state.balance, currency: state.currency,
    wins: state.wins, losses: state.losses, pnl: state.pnl,
    candles: state.candles.length, logs: state.logs.slice(0, 20),
  }));
}).listen(PORT, () => log(`HTTP server on port ${PORT}`));

function pushLogsToGitHub() {
  if (!CONFIG.githubToken) return;
  const data = {
    updated: new Date().toISOString(), balance: state.balance,
    currency: state.currency, wins: state.wins, losses: state.losses,
    pnl: parseFloat(state.pnl.toFixed(2)), logs: state.logs.slice(0, 100),
  };
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const getOpts = {
    hostname: 'api.github.com',
    path: `/repos/${CONFIG.githubRepo}/contents/${CONFIG.logFile}`,
    method: 'GET',
    headers: { 'Authorization': `token ${CONFIG.githubToken}`, 'User-Agent': 'DerivBot-Titan47', 'Accept': 'application/vnd.github.v3+json' },
  };
  const getReq = https.request(getOpts, (res) => {
    let body = ''; res.on('data', d => body += d);
    res.on('end', () => {
      let sha = null;
      try { sha = JSON.parse(body).sha; } catch(e) {}
      const payload = JSON.stringify({ message: `bot: logs ${new Date().toISOString()}`, content, ...(sha ? { sha } : {}) });
      const putOpts = {
        hostname: 'api.github.com',
        path: `/repos/${CONFIG.githubRepo}/contents/${CONFIG.logFile}`,
        method: 'PUT',
        headers: { 'Authorization': `token ${CONFIG.githubToken}`, 'User-Agent': 'DerivBot-Titan47', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      };
      const putReq = https.request(putOpts, (r) => {
        if (r.statusCode === 200 || r.statusCode === 201) log('Logs → GitHub OK');
        else log(`GitHub push ${r.statusCode}`, 'warn');
      });
      putReq.on('error', e => log(`GitHub: ${e.message}`, 'error'));
      putReq.write(payload); putReq.end();
    });
  });
  getReq.on('error', e => log(`GitHub get: ${e.message}`, 'error'));
  getReq.end();
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
  return val;
}

function rsi(arr, period = 14) {
  if (arr.length < period + 1) return null;
  const sl = arr.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < sl.length; i++) { const d = sl[i] - sl[i-1]; if (d > 0) gains += d; else losses -= d; }
  const avgG = gains/period, avgL = losses/period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG/avgL);
}

function getSignal() {
  const closes = state.candles.map(c => c.close);
  if (closes.length < 30) return null;
  const e9 = ema(closes, 9), e21 = ema(closes, 21), rsiVal = rsi(closes, 14);
  const last = closes[closes.length-1], prev = closes[closes.length-2];
  let cv = 0, pv = 0;
  if (e9 > e21) cv++; else pv++;
  if (rsiVal < 45) cv++; else if (rsiVal > 55) pv++;
  if (last > prev) cv++; else pv++;
  if (last > e21) cv++; else pv++;
  const slope = closes.slice(-5).reduce((acc,v,i,a) => i > 0 ? acc+(v-a[i-1]) : acc, 0);
  if (slope > 0) cv++; else pv++;
  log(`Judges CALL:${cv} PUT:${pv} RSI:${rsiVal?.toFixed(1)}`);
  if (cv >= 4) return 'CALL';
  if (pv >= 4) return 'PUT';
  return null;
}

function startBot() {
  const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.appId}`;
  log(`Connecting to Deriv WS: ${wsUrl}`);
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    log('WS connected ✓ — authorizing...');
    ws.send(JSON.stringify({ authorize: CONFIG.token }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.error) { log(`API error: ${msg.error.message}`, 'error'); return; }

    if (msg.msg_type === 'authorize') {
      log(`Authorized ✓ account: ${msg.authorize.loginid} balance: ${msg.authorize.balance} ${msg.authorize.currency}`);
      state.balance = msg.authorize.balance;
      state.currency = msg.authorize.currency;
      // Load candle history
      ws.send(JSON.stringify({ ticks_history: CONFIG.symbol, end: 'latest', count: 100, style: 'candles', granularity: 60 }));
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
    }

    if (msg.msg_type === 'candles') {
      state.candles = msg.candles.map(c => ({ close: parseFloat(c.close) }));
      log(`${state.candles.length} candles loaded ✓`);
      ws.send(JSON.stringify({ ticks: CONFIG.symbol, subscribe: 1 }));
    }
    if (msg.msg_type === 'ohlc') {
      const c = msg.ohlc;
      if (state.candles.length > 0) state.candles[state.candles.length-1] = { close: parseFloat(c.close) };
    }
    if (msg.msg_type === 'tick') {
      if (!state.active && !state.contractId) {
        if (state.pnl <= -CONFIG.maxLoss) { log('Max loss hit', 'warn'); return; }
        if (state.pnl >= CONFIG.maxWin) { log('Max win hit', 'warn'); return; }
        const signal = getSignal();
        if (signal) {
          state.active = true;
          log(`Signal: ${signal} → buying`);
          ws.send(JSON.stringify({ buy: 1, price: CONFIG.stake, parameters: {
            contract_type: signal, symbol: CONFIG.symbol,
            duration: CONFIG.duration, duration_unit: CONFIG.durationUnit,
            basis: 'stake', amount: CONFIG.stake, currency: state.currency || 'USD',
          }}));
        }
      }
    }
    if (msg.msg_type === 'buy') {
      if (msg.error) { log(`Buy error: ${msg.error.message}`, 'error'); state.active = false; }
      else {
        state.contractId = msg.buy.contract_id;
        log(`Contract ${state.contractId} open`);
        ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: state.contractId, subscribe: 1 }));
      }
    }
    if (msg.msg_type === 'proposal_open_contract') {
      const c = msg.proposal_open_contract;
      if (c.is_sold) {
        const profit = parseFloat(c.profit);
        state.pnl += profit;
        if (profit > 0) { state.wins++; log(`WIN +$${profit.toFixed(2)} PnL:$${state.pnl.toFixed(2)}`, 'win'); }
        else { state.losses++; log(`LOSS $${profit.toFixed(2)} PnL:$${state.pnl.toFixed(2)}`, 'loss'); }
        state.contractId = null; state.active = false;
        if ((state.wins + state.losses) % 5 === 0) pushLogsToGitHub();
      }
    }
    if (msg.msg_type === 'balance') {
      state.balance = msg.balance.balance;
      state.currency = msg.balance.currency;
      log(`Balance: ${state.balance} ${state.currency}`);
    }
  });

  ws.on('error', e => log(`WS error: ${e.message}`, 'error'));
  ws.on('close', (code) => {
    log(`WS closed (${code}), reconnecting in 15s...`, 'warn');
    state.active = false; state.contractId = null;
    setTimeout(startBot, 15000);
  });

  setInterval(pushLogsToGitHub, 120000);
}

startBot();
