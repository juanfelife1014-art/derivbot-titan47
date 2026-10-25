// DerivBot Titan47 - Node.js Server Bot
// Conecta a Deriv via nueva API OTP, opera Vol 75, escribe logs a GitHub

const https = require('https');
const { WebSocket } = require('ws');

const CONFIG = {
  appId: process.env.DERIV_APP_ID,
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

let ws = null;
let state = {
  balance: 0,
  currency: 'USD',
  wins: 0,
  losses: 0,
  pnl: 0,
  active: false,
  contractId: null,
  candles: [],
  logs: [],
  lastLogPush: Date.now(),
};

function log(msg, type = 'info') {
  const ts = new Date().toISOString();
  const entry = { ts, msg, type };
  state.logs.unshift(entry);
  if (state.logs.length > 500) state.logs.pop();
  console.log(`[${ts}][${type.toUpperCase()}] ${msg}`);
}

// ── GitHub log push ──────────────────────────────────────────────────────────
function pushLogsToGitHub() {
  const data = {
    updated: new Date().toISOString(),
    balance: state.balance,
    currency: state.currency,
    wins: state.wins,
    losses: state.losses,
    pnl: parseFloat(state.pnl.toFixed(2)),
    logs: state.logs.slice(0, 100),
  };
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');

  // Get current SHA first
  const getOpts = {
    hostname: 'api.github.com',
    path: `/repos/${CONFIG.githubRepo}/contents/${CONFIG.logFile}`,
    method: 'GET',
    headers: {
      'Authorization': `token ${CONFIG.githubToken}`,
      'User-Agent': 'DerivBot-Titan47',
      'Accept': 'application/vnd.github.v3+json',
    },
  };

  const getReq = https.request(getOpts, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      let sha = null;
      try { sha = JSON.parse(body).sha; } catch(e) {}
      
      const payload = JSON.stringify({
        message: `bot: update logs ${new Date().toISOString()}`,
        content,
        ...(sha ? { sha } : {}),
      });

      const putOpts = {
        hostname: 'api.github.com',
        path: `/repos/${CONFIG.githubRepo}/contents/${CONFIG.logFile}`,
        method: 'PUT',
        headers: {
          'Authorization': `token ${CONFIG.githubToken}`,
          'User-Agent': 'DerivBot-Titan47',
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const putReq = https.request(putOpts, (r) => {
        if (r.statusCode === 200 || r.statusCode === 201) {
          log('Logs pushed to GitHub', 'info');
        } else {
          log(`GitHub push status: ${r.statusCode}`, 'warn');
        }
      });
      putReq.on('error', e => log(`GitHub error: ${e.message}`, 'error'));
      putReq.write(payload);
      putReq.end();
    });
  });
  getReq.on('error', e => log(`GitHub get error: ${e.message}`, 'error'));
  getReq.end();
}

// ── Deriv OTP connect ────────────────────────────────────────────────────────
function getOTP() {
  return new Promise((resolve, reject) => {
    // Step 1: GET /accounts
    const opts = {
      hostname: 'api.derivws.com',
      path: '/accounts',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'X-App-ID': CONFIG.appId,
        'Accept': 'application/json',
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const accounts = JSON.parse(body);
          if (!accounts.length) return reject(new Error('No accounts'));
          const accountId = accounts[0].id;
          log(`Account: ${accountId}`);

          // Step 2: POST /accounts/{id}/otp
          const postData = '';
          const otpOpts = {
            hostname: 'api.derivws.com',
            path: `/accounts/${accountId}/otp`,
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${CONFIG.token}`,
              'X-App-ID': CONFIG.appId,
              'Content-Length': 0,
            },
          };
          const otpReq = https.request(otpOpts, (r) => {
            let b = '';
            r.on('data', d => b += d);
            r.on('end', () => {
              try {
                const resp = JSON.parse(b);
                if (resp.ws_url) {
                  log(`OTP OK → ${resp.ws_url}`);
                  resolve(resp.ws_url);
                } else {
                  reject(new Error(`OTP fail: ${b}`));
                }
              } catch(e) { reject(e); }
            });
          });
          otpReq.on('error', reject);
          otpReq.end();
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Indicators ───────────────────────────────────────────────────────────────
function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = arr.slice(-period).reduce((a, b) => a + b, 0) / period;
  for (let i = arr.length - period + 1; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

function rsi(arr, period = 14) {
  if (arr.length < period + 1) return null;
  const sl = arr.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

// ── Signal (5 judges) ────────────────────────────────────────────────────────
function getSignal() {
  const closes = state.candles.map(c => c.close);
  if (closes.length < 30) return null;

  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  const rsiVal = rsi(closes, 14);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];

  let callVotes = 0, putVotes = 0;

  // Judge 1: EMA cross
  if (e9 > e21) callVotes++; else putVotes++;

  // Judge 2: RSI
  if (rsiVal < 45) callVotes++;
  else if (rsiVal > 55) putVotes++;

  // Judge 3: Momentum
  if (last > prev) callVotes++; else putVotes++;

  // Judge 4: Price vs EMA21
  if (last > e21) callVotes++; else putVotes++;

  // Judge 5: Recent slope
  const slope = closes.slice(-5).reduce((acc, v, i, a) => i > 0 ? acc + (v - a[i-1]) : acc, 0);
  if (slope > 0) callVotes++; else putVotes++;

  log(`Judges → CALL:${callVotes} PUT:${putVotes} RSI:${rsiVal?.toFixed(1)} EMA9:${e9?.toFixed(2)}`);

  if (callVotes >= 4) return 'CALL';
  if (putVotes >= 4) return 'PUT';
  return null;
}

// ── WebSocket bot ────────────────────────────────────────────────────────────
async function connect() {
  log('Connecting to Deriv...');
  let wsUrl;
  try { wsUrl = await getOTP(); }
  catch(e) { log(`OTP error: ${e.message}`, 'error'); setTimeout(connect, 30000); return; }

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    log('WebSocket connected');
    ws.send(JSON.stringify({ ticks_history: CONFIG.symbol, end: 'latest', count: 100, style: 'candles', granularity: 60 }));
    ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.msg_type === 'candles') {
      state.candles = msg.candles.map(c => ({ close: c.close }));
      log(`${state.candles.length} candles loaded`);
      ws.send(JSON.stringify({ ticks: CONFIG.symbol, subscribe: 1 }));
    }

    if (msg.msg_type === 'ohlc') {
      const c = msg.ohlc;
      if (state.candles.length > 0) {
        state.candles[state.candles.length - 1] = { close: parseFloat(c.close) };
      }
    }

    if (msg.msg_type === 'tick') {
      if (!state.active && !state.contractId) {
        // Check PnL limits
        if (state.pnl <= -CONFIG.maxLoss) { log('Max loss reached, stopping', 'warn'); return; }
        if (state.pnl >= CONFIG.maxWin)   { log('Max win reached, stopping', 'warn'); return; }

        const signal = getSignal();
        if (signal) {
          state.active = true;
          log(`Signal: ${signal} → buying`, 'info');
          ws.send(JSON.stringify({
            buy: 1,
            price: CONFIG.stake,
            parameters: {
              contract_type: signal,
              symbol: CONFIG.symbol,
              duration: CONFIG.duration,
              duration_unit: CONFIG.durationUnit,
              basis: 'stake',
              amount: CONFIG.stake,
              currency: state.currency || 'USD',
            },
          }));
        }
      }
    }

    if (msg.msg_type === 'buy') {
      if (msg.error) {
        log(`Buy error: ${msg.error.message}`, 'error');
        state.active = false;
      } else {
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
        if (profit > 0) { state.wins++; log(`WIN +$${profit.toFixed(2)} | PnL: $${state.pnl.toFixed(2)}`, 'win'); }
        else            { state.losses++; log(`LOSS $${profit.toFixed(2)} | PnL: $${state.pnl.toFixed(2)}`, 'loss'); }
        state.contractId = null;
        state.active = false;

        // Push logs every 5 trades
        if ((state.wins + state.losses) % 5 === 0) pushLogsToGitHub();
      }
    }

    if (msg.msg_type === 'balance') {
      state.balance = msg.balance.balance;
      state.currency = msg.balance.currency;
    }
  });

  ws.on('error', (e) => { log(`WS error: ${e.message}`, 'error'); });
  ws.on('close', () => {
    log('WS closed, reconnecting in 10s...', 'warn');
    state.active = false;
    state.contractId = null;
    setTimeout(connect, 10000);
  });

  // Push logs every 2 minutes
  setInterval(pushLogsToGitHub, 120000);
}

connect();
