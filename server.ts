import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

// ==========================================
// 实时可转债仿真量化引擎 (Simulation Quant Engine)
// 为了在沙盒预览环境中提供实时交互且永不宕机的演示，Node.js 模拟了
// 沪深市场成交额排名前 50 名的最活跃可转债，以及日内 tick 演化。
// ==========================================

interface BondSimulation {
  code: string;
  name: string;
  basePrice: number;
  currentPrice: number;
  history: number[]; // 20分钟/K线价格历史
  tickHistory: { price: number; volume: number }[]; // 日内tick历史，用于精确VWAP
  cumulativeVolume: number;
  cumulativeAmount: number;
}

// 模拟的 50 只高成交量活跃可转债配制表
const BOND_SEEDS = [
  { code: "113673", name: "哈尔转债", basePrice: 132.50 },
  { code: "123180", name: "麦捷转债", basePrice: 118.20 },
  { code: "123111", name: "东财转债", basePrice: 124.60 },
  { code: "110044", name: "广电转债", basePrice: 215.30 },
  { code: "123143", name: "胜蓝转债", basePrice: 145.80 },
  { code: "123025", name: "精测转债", basePrice: 112.40 },
  { code: "113601", name: "塞力转债", basePrice: 104.90 },
  { code: "128211", name: "三江转债", basePrice: 122.10 },
  { code: "113011", name: "国金转债", basePrice: 115.60 },
  { code: "128041", name: "盛路转债", basePrice: 167.30 },
  { code: "123018", name: "溢利转债", basePrice: 285.40 },
  { code: "127096", name: "泰坦转债", basePrice: 121.20 },
  { code: "128117", name: "红墙转债", basePrice: 109.80 },
  { code: "113016", name: "小康转债", basePrice: 341.20 },
  { code: "113027", name: "苏银转债", basePrice: 119.50 },
  { code: "128111", name: "中矿转债", basePrice: 138.40 },
  { code: "123013", name: "横河转债", basePrice: 312.80 },
  { code: "123227", name: "雅创转债", basePrice: 154.20 },
  { code: "110068", name: "龙净转债", basePrice: 117.30 },
  { code: "128014", name: "百川转债", basePrice: 126.90 },
  { code: "123136", name: "妙可转债", basePrice: 115.40 },
  { code: "123061", name: "恒锋转债", basePrice: 139.80 },
  { code: "113636", name: "国投转债", basePrice: 113.10 },
  { code: "127018", name: "锋龙转债", basePrice: 116.50 },
  { code: "113054", name: "重银转债", basePrice: 105.70 },
  { code: "113650", name: "大商转债", basePrice: 108.90 },
  { code: "123126", name: "富瀚转债", basePrice: 119.30 },
  { code: "113059", name: "浙22转债", basePrice: 112.80 },
  { code: "127042", name: "科伦转债", basePrice: 158.40 },
  { code: "113642", name: "立博转债", basePrice: 135.20 },
  { code: "123121", name: "天创转债", basePrice: 106.30 },
  { code: "113651", name: "合兴转债", basePrice: 114.60 },
  { code: "123176", name: "明泰转债", basePrice: 128.50 },
  { code: "118023", name: "天合转债", basePrice: 105.10 },
  { code: "113051", name: "金能转债", basePrice: 107.40 },
  { code: "127056", name: "精工转债", basePrice: 114.20 },
  { code: "113062", name: "常银转债", basePrice: 111.90 },
  { code: "113052", name: "兴业转债", basePrice: 108.30 },
  { code: "123034", name: "九典转债", basePrice: 142.60 },
  { code: "127072", name: "华宏转债", basePrice: 121.50 },
  { code: "111007", name: "瑞科转债", basePrice: 119.20 },
  { code: "123114", name: "强力转债", basePrice: 126.30 },
  { code: "123169", name: "利民转债", basePrice: 110.40 },
  { code: "113042", name: "策略转债", basePrice: 103.80 },
  { code: "123188", name: "宏微转债", basePrice: 116.10 },
  { code: "113045", name: "平煤转债", basePrice: 122.40 },
  { code: "128128", name: "高澜转债", basePrice: 151.70 },
  { code: "113563", name: "建工转债", basePrice: 113.80 },
  { code: "127091", name: "中化转债", basePrice: 111.20 },
  { code: "128039", name: "德尔转债", basePrice: 129.80 },
];

let bondDatabase: BondSimulation[] = [];

// 初始化模拟数据
function initializeSimulatedDatabase() {
  bondDatabase = BOND_SEEDS.map((seed) => {
    const history: number[] = [];
    const tickHistory: { price: number; volume: number }[] = [];
    let cumulativeVolume = 0;
    let cumulativeAmount = 0;

    // 前推生成 25 根分钟价格数据
    let current = seed.basePrice;
    for (let i = 0; i < 30; i++) {
      // 适度的波动漂移
      const changePercent = (Math.random() - 0.5) * 0.008; // -0.4% ~ 0.4%
      current = current * (1 + changePercent);
      history.push(Number(current.toFixed(3)));

      const stepVolume = Math.floor(2000 + Math.random() * 8000);
      cumulativeVolume += stepVolume;
      cumulativeAmount += current * stepVolume;
    }

    return {
      code: seed.code,
      name: seed.name,
      basePrice: seed.basePrice,
      currentPrice: Number(current.toFixed(3)),
      history,
      tickHistory,
      cumulativeVolume,
      cumulativeAmount,
    };
  });
}

// 仿真 tick 更新器，模拟实际盘中活跃交易
function simulateTradingTicks() {
  bondDatabase.forEach((bond) => {
    // 价格几何游走 波动比例：-0.25% 到 +0.25%
    const changePercent = (Math.random() - 0.5) * 0.005;
    bond.currentPrice = Number((bond.currentPrice * (1 + changePercent)).toFixed(3));
    
    // 生成随机成交量
    const newVolume = Math.floor(500 + Math.random() * 3000);
    const newAmount = bond.currentPrice * newVolume;

    bond.cumulativeVolume += newVolume;
    bond.cumulativeAmount += newAmount;

    // 添加到 tick 历史中
    bond.tickHistory.push({ price: bond.currentPrice, volume: newVolume });
    if (bond.tickHistory.length > 200) {
      bond.tickHistory.shift();
    }

    // 偶尔将收盘价写入分钟序列
    if (Math.random() > 0.6) {
      bond.history.push(bond.currentPrice);
      if (bond.history.length > 50) {
        bond.history.shift(); // 限制内存列表长度
      }
    }
  });
}

// 初始化
initializeSimulatedDatabase();

// 每 3.5 秒模拟一次交易变动（让仪表盘极其富有生命力且极其逼真）
setInterval(simulateTradingTicks, 3500);

// ==========================================
// API 路由
// ==========================================

app.use(express.json());

// ==========================================
// 模拟账户持久化与撮合引擎 (Express Sandbox Mirror)
// ==========================================
const PORTFOLIO_PATH = path.join(process.cwd(), "paper_portfolio.json");

function loadPortfolio() {
  if (!fs.existsSync(PORTFOLIO_PATH)) {
    const initial = {
      cash: 100000.0,
      positions: {} // symbol -> { symbol, name, amount, costPrice }
    };
    try {
      fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(initial, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to initialize paper_portfolio.json:", err);
    }
    return initial;
  }
  try {
    const content = fs.readFileSync(PORTFOLIO_PATH, "utf8");
    const data = JSON.parse(content);
    if (typeof data.cash !== "number") data.cash = 100000.0;
    if (!data.positions) data.positions = {};
    return data;
  } catch (e) {
    return { cash: 100000.0, positions: {} };
  }
}

function savePortfolio(data: any) {
  try {
    fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save portfolio JSON:", e);
  }
}

// GET /api/paper/account - 获取模拟账户以及持仓详情
app.get("/api/paper/account", (req, res) => {
  try {
    const portfolio = loadPortfolio();
    const positionsList: any[] = [];
    let marketValueTotal = 0;

    Object.keys(portfolio.positions).forEach((symbol) => {
      const pos = portfolio.positions[symbol];
      const liveBond = bondDatabase.find((b) => b.code === symbol);
      
      const currentPrice = liveBond ? liveBond.currentPrice : pos.costPrice;
      const amount = pos.amount;
      const costPrice = pos.costPrice;
      const mVal = amount * currentPrice;
      marketValueTotal += mVal;

      const pnl = (currentPrice - costPrice) * amount;
      const costTotal = costPrice * amount;
      const pnlRatio = costTotal > 0 ? (pnl / costTotal) * 100 : 0.0;

      positionsList.push({
        symbol: symbol,
        name: pos.name || (liveBond ? liveBond.name : `转债${symbol}`),
        amount: amount,
        cost_price: Number(costPrice.toFixed(3)),
        current_price: Number(currentPrice.toFixed(3)),
        market_value: Number(mVal.toFixed(2)),
        pnl: Number(pnl.toFixed(2)),
        pnl_ratio: Number(pnlRatio.toFixed(2))
      });
    });

    const totalAssets = portfolio.cash + marketValueTotal;

    res.json({
      status: "success",
      data: {
        total_assets: Number(totalAssets.toFixed(2)),
        cash: Number(portfolio.cash.toFixed(2)),
        market_value: Number(marketValueTotal.toFixed(2)),
        positions: positionsList
      }
    });
  } catch (e: any) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// POST /api/paper/trade - 模拟撮合
app.post("/api/paper/trade", (req, res) => {
  try {
    let { symbol, action, price, amount } = req.body;
    amount = parseInt(amount);
    price = parseFloat(price);

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ status: "error", message: "交易数量（张数）必须大于 0" });
    }
    if (isNaN(price) || price <= 0) {
      return res.status(400).json({ status: "error", message: "交易成交价格必须大于 0" });
    }
    action = String(action).toUpperCase();
    if (action !== "BUY" && action !== "SELL") {
      return res.status(400).json({ status: "error", message: "交易方向只能为 BUY 或 SELL" });
    }

    const portfolio = loadPortfolio();
    const liveBond = bondDatabase.find((b) => b.code === symbol);
    const bondName = liveBond ? liveBond.name : `转债${symbol}`;

    const feeRate = 0.0002; // 万分之二交易手续费率
    const tradeValue = price * amount;
    const fee = tradeValue * feeRate;

    if (action === "BUY") {
      const totalCost = tradeValue + fee;
      if (portfolio.cash < totalCost) {
        return res.status(400).json({
          status: "error",
          message: `可用资金不足。需要总资金: ${totalCost.toFixed(2)}元 (成交额 ${tradeValue.toFixed(2)}元 + 万二手续费 ${fee.toFixed(2)}元)，当前现金可用余额: ${portfolio.cash.toFixed(2)}元`
        });
      }

      portfolio.cash -= totalCost;

      if (portfolio.positions[symbol]) {
        const existing = portfolio.positions[symbol];
        const oldAmount = existing.amount;
        const oldCost = existing.costPrice;
        const newAmount = oldAmount + amount;
        
        // 重新摊平买入均价 = (老成本*老持仓 + 新总价 + 佣金) / 新数量
        const newCostPrice = (oldCost * oldAmount + tradeValue + fee) / newAmount;
        
        existing.amount = newAmount;
        existing.costPrice = newCostPrice;
        existing.name = bondName;
      } else {
        const newCostPrice = (tradeValue + fee) / amount;
        portfolio.positions[symbol] = {
          symbol: symbol,
          name: bondName,
          amount: amount,
          costPrice: newCostPrice
        };
      }

      savePortfolio(portfolio);

      res.json({
        status: "success",
        data: {
          success: true,
          message: `【模拟交易】买入成交成功！已购入 ${bondName}(${symbol}) ${amount}张，成交单价: ${price.toFixed(3)}元，手续费(万二): ${fee.toFixed(2)}元。`,
          cash: Number(portfolio.cash.toFixed(2))
        }
      });
    } else {
      // SELL
      if (!portfolio.positions[symbol] || portfolio.positions[symbol].amount < amount) {
        const available = portfolio.positions[symbol] ? portfolio.positions[symbol].amount : 0;
        return res.status(400).json({
          status: "error",
          message: `当前持仓份额不足！请求卖出 ${amount}张，可用持仓额仅为 ${available}张`
        });
      }

      const netRevenue = tradeValue - fee;
      portfolio.cash += netRevenue;

      const existing = portfolio.positions[symbol];
      if (existing.amount === amount) {
        delete portfolio.positions[symbol];
      } else {
        existing.amount -= amount;
      }

      savePortfolio(portfolio);

      res.json({
        status: "success",
        data: {
          success: true,
          message: `【模拟交易】卖出成交成功！已放回 ${bondName}(${symbol})  ${amount}张，成交单价: ${price.toFixed(3)}元，手续费(万二): ${fee.toFixed(2)}元，资金回拢: ${netRevenue.toFixed(2)}元。`,
          cash: Number(portfolio.cash.toFixed(2))
        }
      });
    }
  } catch (e: any) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// POST /api/paper/reset - 重置模拟盘
app.post("/api/paper/reset", (req, res) => {
  try {
    const initial = {
      cash: 100000.0,
      positions: {}
    };
    savePortfolio(initial);
    res.json({
      status: "success",
      message: "模拟交易账户已重置成功，可用资金恢复至 100000.00 元，持仓已清空。"
    });
  } catch (e: any) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// API: 获取可转债实时量化信号数据 (支持修改 Bollinger 周期与方差宽度参数)
app.get("/api/signals", (req, res) => {
  // 从 query 参数里读取参数，支持前端实时动态调整
  const period = parseInt(req.query.period as string) || 20;
  const stdMultiplier = parseFloat(req.query.stdDev as string) || 2.0;

  const result = bondDatabase.map((bond) => {
    // 1. 获取近期的 N 个收盘价
    const recentClose = bond.history.slice(-period);
    
    // 2. 计算布林带
    const count = recentClose.length;
    let mean = bond.currentPrice;
    let std = 0.05;

    if (count > 0) {
      const sum = recentClose.reduce((acc, val) => acc + val, 0);
      mean = sum / count;

      // 标准差
      const sqDiffs = recentClose.map((val) => Math.pow(val - mean, 2));
      const variance = sqDiffs.reduce((acc, val) => acc + val, 0) / (count > 1 ? count - 1 : 1);
      std = Math.sqrt(variance);
      if (std < 0.01) std = 0.012; // 极端低波动下限保障
    }

    const upperBand = Number((mean + stdMultiplier * std).toFixed(3));
    const lowerBand = Number((mean - stdMultiplier * std).toFixed(3));

    // 3. 实时 VWAP 采用累计成交总额 / 累计总股数
    const vwap = bond.cumulativeVolume > 0 
      ? Number((bond.cumulativeAmount / bond.cumulativeVolume).toFixed(3))
      : bond.currentPrice;

    // 4. 判定决策信号
    let signal = "WAIT";
    if (bond.currentPrice <= lowerBand) {
      signal = "BUY_ZONE";
    } else if (bond.currentPrice >= upperBand) {
      signal = "SELL_ZONE";
    }

    return {
      code: bond.code,
      name: bond.name,
      price: bond.currentPrice,
      vwap: vwap,
      upper_band: upperBand,
      lower_band: lowerBand,
      signal: signal,
      buy_price: lowerBand,
      sell_price: upperBand,
      turnover: Number((bond.cumulativeAmount / 10000).toFixed(2)), // 万元
      history: bond.history.slice(-30), // 提供最近30个历史价格绘制优雅折线图
    };
  });

  // 排序：默认将高信号活跃的（BUY_ZONE 和 SELL_ZONE 靠前）或者成交额靠前的在前
  // 这里做简易排序：BUY_ZONE 第一，SELL_ZONE 第二，WAIT 第三；或者按照成交额从大到小
  const sortedResult = [...result].sort((a, b) => {
    if (a.signal === "BUY_ZONE" && b.signal !== "BUY_ZONE") return -1;
    if (a.signal !== "BUY_ZONE" && b.signal === "BUY_ZONE") return 1;
    if (a.signal === "SELL_ZONE" && b.signal === "WAIT") return -1;
    if (a.signal === "WAIT" && b.signal === "SELL_ZONE") return 1;
    return b.turnover - a.turnover; // 成交额大的在前
  });

  res.json({
    status: "success",
    total_count: sortedResult.length,
    last_updated: new Date().toLocaleTimeString("zh-CN"),
    query_params: { period, stdDev: stdMultiplier },
    data: sortedResult
  });
});

// APIs for manual interaction to make UI experience extremely playful
app.post("/api/simulate-market-shock", (req, res) => {
  const { type } = req.body; // "bull", "bear", "spike"
  bondDatabase.forEach(bond => {
    let shock = 0;
    if (type === "bull") {
      shock = (Math.random() * 0.02) + 0.005; // 整体暴涨 0.5% ~ 2.5%
    } else if (type === "bear") {
      shock = -((Math.random() * 0.02) + 0.005); // 整体跌
    } else if (type === "spike") {
      shock = (Math.random() - 0.5) * 0.05; // 分化，大波动 -2.5% ~ 2.5%
    }
    bond.currentPrice = Number((bond.currentPrice * (1 + shock)).toFixed(3));
    bond.history.push(bond.currentPrice);
    if (bond.history.length > 50) bond.history.shift();
  });
  res.json({ status: "success", message: `已成功注入全市场【${type}】波动行情冲击！` });
});

// Vite 静态文件服务注入
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Express/Vite] Full-Stack server booted at http://0.0.0.0:${PORT}`);
  });
}

startServer();
