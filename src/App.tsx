import React, { useState, useEffect, useMemo } from "react";
import { 
  TrendingUp, 
  TrendingDown, 
  RefreshCw, 
  Search, 
  SlidersHorizontal,
  Sliders,
  Play,
  Activity,
  Zap,
  Info,
  Layers,
  ChevronDown,
  Check,
  Clock,
  Trash2,
  Plus,
  BookOpen,
  Award,
  Target,
  Flame,
  AlertCircle
} from "lucide-react";

// 定义可转债格式
interface BondSignal {
  code: string;
  name: string;
  price: number;
  vwap: number;
  upper_band: number;
  lower_band: number;
  signal: "BUY_ZONE" | "SELL_ZONE" | "WAIT";
  buy_price: number;
  sell_price: number;
  turnover: number;
  history: number[];
}

// 纪律打卡日志格式
interface TradeLog {
  id: string;
  code: string;
  name: string;
  type: "BUY" | "SELL";
  suggestedPrice: number;
  actualPrice: number;
  quantity: number;
  slippagePerUnit: number;
  slippageTotal: number;
  verdict: string;
  isPerfect: boolean;
  timestamp: string;
}

export default function App() {
  // 量化核心配置
  const [period, setPeriod] = useState<number>(20);
  const [stdDev, setStdDev] = useState<number>(2.0);

  // 界面过滤与搜索
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [signalFilter, setSignalFilter] = useState<"ALL" | "BUY_ZONE" | "SELL_ZONE" | "WAIT">("ALL");

  // 列表信号数据状态
  const [signals, setSignals] = useState<BondSignal[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  
  // 10秒定时器倒计时
  const [countdown, setCountdown] = useState<number>(10);
  
  // 控制台微调面板是否展开
  const [showConfig, setShowConfig] = useState<boolean>(false);

  // 模拟情绪冲击的文本状态反馈
  const [shockMessage, setShockMessage] = useState<string>("");

  // 交易时段状态
  const [tradingStatus, setTradingStatus] = useState<{ trading: boolean; session: string; session_label: string; current_time: string } | null>(null);
  // 非交易时段是否至少加载过一次数据
  const [hasInitialLoad, setHasInitialLoad] = useState<boolean>(false);
  // 后端连接状态
  const [connectionError, setConnectionError] = useState<boolean>(false);

  // 交易纪律打卡模块状态
  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);
  const [selectedBondCode, setSelectedBondCode] = useState<string>("");
  const [tradeType, setTradeType] = useState<"BUY" | "SELL">("BUY");
  const [suggestedPrice, setSuggestedPrice] = useState<number>(0);
  const [actualPrice, setActualPrice] = useState<string>(""); // 用字符串保存，防止输入小数点或清空时遇到阻碍
  const [tradeQuantity, setTradeQuantity] = useState<number>(100); // 默认百张
  const [confirmClear, setConfirmClear] = useState<boolean>(false); // 避免 iFrame 内 window.confirm 失效，采用内置按钮状态二次确认
  
  // 模拟交易引擎组件状态
  const [rightPanelTab, setRightPanelTab] = useState<"PAPER_ENGINE" | "DISCIPLINE_PUNCH">("PAPER_ENGINE");
  const [paperAccount, setPaperAccount] = useState<any>(null);
  const [paperTradeLoading, setPaperTradeLoading] = useState<boolean>(false);
  const [tradeStatusMessage, setTradeStatusMessage] = useState<{ text: string, type: "success" | "error" } | null>(null);
  const [confirmReset, setConfirmReset] = useState<boolean>(false);

  // 从 LocalStorage 读取历史
  useEffect(() => {
    const saved = localStorage.getItem("qd_trade_logs");
    if (saved) {
      try {
        setTradeLogs(JSON.parse(saved));
      } catch (e) {
        console.error("加载历史量化交易日志失败", e);
      }
    }
  }, []);

  // 写入 LocalStorage
  const saveLogs = (logs: TradeLog[]) => {
    setTradeLogs(logs);
    localStorage.setItem("qd_trade_logs", JSON.stringify(logs));
  };

  // 快捷记录事件处理器 (常由表格内点击触发)
  const handleQuickLog = (bond: BondSignal) => {
    setSelectedBondCode(bond.code);
    const type = bond.signal === "SELL_ZONE" ? "SELL" : "BUY";
    setTradeType(type);
    const sugg = type === "BUY" ? bond.lower_band : bond.upper_band;
    setSuggestedPrice(sugg);
    setActualPrice(bond.price.toString());
  };

  // 当信号数据初始拉取完成，或者手动选择标的发生改变时，自动带入算法建议价
  useEffect(() => {
    if (signals.length > 0) {
      if (!selectedBondCode) {
        // 第一顺位选择任意处于买卖买点区域的标的，若无则选第一个标的
        const signalBond = signals.find(s => s.signal !== "WAIT");
        if (signalBond) {
          setSelectedBondCode(signalBond.code);
          const type = signalBond.signal === "SELL_ZONE" ? "SELL" : "BUY";
          setTradeType(type);
          setSuggestedPrice(type === "BUY" ? signalBond.lower_band : signalBond.upper_band);
          setActualPrice(signalBond.price.toString());
        } else {
          setSelectedBondCode(signals[0].code);
          setSuggestedPrice(tradeType === "BUY" ? signals[0].lower_band : signals[0].upper_band);
          setActualPrice(signals[0].price.toString());
        }
      } else {
        const found = signals.find(s => s.code === selectedBondCode);
        if (found) {
          const sugg = tradeType === "BUY" ? found.lower_band : found.upper_band;
          setSuggestedPrice(sugg);
          // 仅在实际成交价为空时，或在非高频改动中关联默认值
          if (!actualPrice) {
            setActualPrice(found.price.toString());
          }
        }
      }
    }
  }, [selectedBondCode, tradeType, signals]);

  // 实时根据输入计算滑点损耗与纪律评价
  const slippageCalculation = useMemo(() => {
    const actPriceNum = parseFloat(actualPrice) || 0;
    if (!suggestedPrice || !actPriceNum) {
      return { slippagePerUnit: 0, slippageTotal: 0, isPerfect: true, message: "请输入有效实际成交价开始评估纪律" };
    }
    
    // 买入：实际价格 <= 建议下轨 为完美执行。若大于则具有正溢价(滑点损耗)
    // 卖出：实际价格 >= 建议上轨 为完美执行。若小于则具有滑点损耗
    let slippagePerUnit = 0;
    if (tradeType === "BUY") {
      slippagePerUnit = actPriceNum - suggestedPrice;
    } else {
      slippagePerUnit = suggestedPrice - actPriceNum;
    }

    const isPerfect = slippagePerUnit <= 0;
    const slippageTotal = isPerfect ? 0 : slippagePerUnit * tradeQuantity;

    let message = "";
    if (isPerfect) {
      message = tradeType === "BUY" 
        ? "【本次执行完美】🟢 纪律性极佳！实际买入价优于或等于建议价，未出现拖延导致的摩擦损耗。"
        : "【本次执行完美】🟢 出色逃顶！实际卖出价优于或等于建议阻力价，执行力超群！";
    } else {
      message = tradeType === "BUY"
        ? `【本次执行存在犹豫】🔴 滑点丢失 ${slippageTotal.toFixed(2)} 元。分秒之间，坚决执行下锚是摆脱散户偏误的灵魂！`
        : ` ${tradeType === "SELL" ? "【本次执行存在犹豫】" : ""}🔴 卖出迟疑！因滑点缩水丢失约 ${slippageTotal.toFixed(2)} 元。切忌贪小回撤，坚守离场！`;
    }

    return { slippagePerUnit, slippageTotal, isPerfect, message };
  }, [tradeType, suggestedPrice, actualPrice, tradeQuantity]);

  // 表单递交归档
  const handleAddLog = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBondCode) return;
    const bond = signals.find(s => s.code === selectedBondCode);
    if (!bond) return;

    const actPriceNum = parseFloat(actualPrice);
    if (isNaN(actPriceNum) || actPriceNum <= 0) {
      alert("请输入正确的成交价位");
      return;
    }

    const { slippagePerUnit, slippageTotal, isPerfect, message } = slippageCalculation;

    const newLog: TradeLog = {
      id: Date.now().toString(),
      code: bond.code,
      name: bond.name,
      type: tradeType,
      suggestedPrice,
      actualPrice: actPriceNum,
      quantity: tradeQuantity,
      slippagePerUnit,
      slippageTotal,
      verdict: message,
      isPerfect,
      timestamp: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    };

    saveLogs([newLog, ...tradeLogs]);
    // 提示完成，清空实际价
    setActualPrice("");
  };

  const handleDeleteLog = (id: string) => {
    const updated = tradeLogs.filter(log => log.id !== id);
    saveLogs(updated);
  };

  const handleClearLogs = () => {
    saveLogs([]);
    setConfirmClear(false);
  };

  // 从后端 API 拉取数据的异步方法
  const fetchSignals = async (p: number, s: number, isSilent = false) => {
    try {
      if (!isSilent) setLoading(true);
      const res = await fetch(`/api/signals?period=${p}&stdDev=${s}`);
      const json = await res.json();
      if (json.status === "success" && json.data) {
        setSignals(json.data);
        setLastUpdated(json.last_updated);
        setConnectionError(false);
      }
    } catch (err) {
      console.error("连接分析系统失败:", err);
      setConnectionError(true);
    } finally {
      setLoading(false);
    }
  };

  // 从后端获取当前交易时段状态
  const fetchTradingStatus = async () => {
    try {
      const res = await fetch("/api/trading-status");
      const json = await res.json();
      if (json.status === "success" && json.data) {
        setTradingStatus(json.data);
      }
    } catch (err) {
      console.error("获取交易时段状态失败:", err);
    }
  };

  // 1. 初始化拉取：参数变动时拉取最新状态面部，同时获取交易时段状态
  useEffect(() => {
    fetchSignals(period, stdDev, false);
    fetchTradingStatus();
    setCountdown(10);
  }, [period, stdDev]);

  // 2. 按交易时段智能调整刷新频率
  //    交易中：每10秒刷新一次    非交易时段：每60秒刷新一次（降低无效轮询）
  useEffect(() => {
    const isTrading = tradingStatus?.trading ?? false;
    const intervalSeconds = isTrading ? 10 : 60;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          // 非交易时段首次加载后，不再静默刷新
          if (!isTrading && hasInitialLoad) {
            return intervalSeconds;
          }
          fetchSignals(period, stdDev, true);
          if (!hasInitialLoad) setHasInitialLoad(true);
          return intervalSeconds;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [period, stdDev, tradingStatus, hasInitialLoad]);

  // 3. 周期性获取交易时段状态（每60秒）
  useEffect(() => {
    fetchTradingStatus();
    const statusInterval = setInterval(fetchTradingStatus, 60000);
    return () => clearInterval(statusInterval);
  }, []);

  // 模拟行情波动冲击接口
  const handleSimulateShock = async (type: "bull" | "bear" | "spike") => {
    try {
      const typeLabels = { bull: "多头拉升", bear: "空头砸盘", spike: "宽幅震荡" };
      setShockMessage(`已触发全市场【${typeLabels[type]}】压力波动冲击！`);
      
      const response = await fetch("/api/simulate-market-shock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const data = await response.json();
      if (data.status === "success") {
        // 立即拉取
        fetchSignals(period, stdDev, true);
        setTimeout(() => setShockMessage(""), 4000);
      }
    } catch (err) {
      console.error("冲击信号发送失败", err);
      setShockMessage("发送冲击测试失败，请检查后端状态。");
      setTimeout(() => setShockMessage(""), 4000);
    }
  };

  // ==========================================
  // 模拟交易引擎 API 调用与异步同步
  // ==========================================
  const [toast, setToast] = useState<{ text: string, type: "success" | "error" } | null>(null);

  const showToast = (text: string, type: "success" | "error") => {
    setToast({ text, type });
    // Duration set to 4 seconds
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  // 快捷持仓字典 Map
  const posMap = useMemo(() => {
    const map = new Map<string, any>();
    if (paperAccount && paperAccount.positions) {
      paperAccount.positions.forEach((pos: any) => {
        map.set(pos.symbol, pos);
      });
    }
    return map;
  }, [paperAccount]);

  const handleQuickTrade = async (code: string, action: "BUY" | "SELL", price: number, amount: number) => {
    try {
      const res = await fetch("/api/paper/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: code,
          action,
          price,
          amount
        })
      });
      const json = await res.json();
      if (res.ok && json.status === "success") {
        showToast(json.data.message || "模拟交易指令执行成功！", "success");
        fetchPaperAccount();
      } else {
        showToast(json.message || "申报失败，请检查可用余额或持仓头寸", "error");
      }
    } catch (err: any) {
      showToast("连接撮合引擎异常: " + err.message, "error");
    }
  };

  const fetchPaperAccount = async () => {
    try {
      const res = await fetch("/api/paper/account");
      const json = await res.json();
      if (json.status === "success" && json.data) {
        setPaperAccount(json.data);
      }
    } catch (err) {
      console.error("加载模拟交易账户详情失败:", err);
    }
  };

  const handlePaperTradeSubmit = async (actionOverride?: "BUY" | "SELL") => {
    if (!selectedBondCode) return;
    const action = actionOverride || tradeType;
    const priceNum = parseFloat(actualPrice);
    if (isNaN(priceNum) || priceNum <= 0) {
      setTradeStatusMessage({ text: "请输入正确的申报均价（可点击快捷代入）", type: "error" });
      return;
    }

    setPaperTradeLoading(true);
    setTradeStatusMessage(null);
    try {
      const res = await fetch("/api/paper/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: selectedBondCode,
          action,
          price: priceNum,
          amount: tradeQuantity
        })
      });
      const json = await res.json();
      if (res.ok && json.status === "success") {
        setTradeStatusMessage({ text: json.data.message, type: "success" });
        fetchPaperAccount();
      } else {
        setTradeStatusMessage({ text: json.message || "交易被冲销，可能由于持仓/本金不足或行情波动", type: "error" });
      }
    } catch (err: any) {
      setTradeStatusMessage({ text: "连接撮合引擎失败: " + err.message, type: "error" });
    } finally {
      setPaperTradeLoading(false);
    }
  };

  const handlePaperReset = async () => {
    try {
      const res = await fetch("/api/paper/reset", { method: "POST" });
      const json = await res.json();
      if (json.status === "success") {
        setTradeStatusMessage({ text: json.message, type: "success" });
        setConfirmReset(false);
        fetchPaperAccount();
      }
    } catch (err) {
      console.error("重置模拟盘账户失败:", err);
    }
  };

  // 开启模拟盘估值实时轮询
  useEffect(() => {
    fetchPaperAccount();
    const interval = setInterval(fetchPaperAccount, 4000);
    return () => clearInterval(interval);
  }, []);

  // 客户端过滤：按照搜索框输入与标签页分类对 50 只转债进行过滤
  const filteredBonds = useMemo(() => {
    return signals.filter((bond) => {
      const matchesSearch = bond.code.includes(searchQuery) || bond.name.includes(searchQuery);
      const matchesSignal = signalFilter === "ALL" || bond.signal === signalFilter;
      return matchesSearch && matchesSignal;
    });
  }, [signals, searchQuery, signalFilter]);

  // 信号分类统计
  const statCounts = useMemo(() => {
    const total = signals.length;
    const buys = signals.filter((s) => s.signal === "BUY_ZONE").length;
    const sells = signals.filter((s) => s.signal === "SELL_ZONE").length;
    const waits = signals.filter((s) => s.signal === "WAIT").length;
    return { total, buys, sells, waits };
  }, [signals]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans selection:bg-red-500 selection:text-white">
      {/* 呼吸灯高亮CSS定义 */}
      <style>{`
        @keyframes subtle-red-breath {
          0%, 100% {
            background-color: rgba(254, 242, 242, 0.45);
            box-shadow: inset 4px 0px 0px 0px #ef4444;
          }
          50% {
            background-color: rgba(254, 242, 242, 1.0);
            box-shadow: inset 4px 0px 0px 0px #f87171;
          }
        }
        @keyframes subtle-green-breath {
          0%, 100% {
            background-color: rgba(240, 253, 250, 0.45);
            box-shadow: inset 4px 0px 0px 0px #10b981;
          }
          50% {
            background-color: rgba(240, 253, 250, 1.0);
            box-shadow: inset 4px 0px 0px 0px #34d399;
          }
        }
        .row-alert-buy {
          animation: subtle-red-breath 1.8s infinite ease-in-out;
        }
        .row-alert-sell {
          animation: subtle-green-breath 1.8s infinite ease-in-out;
        }
      `}</style>

      {/* 顶部主工作栏 */}
      <header className="bg-white border-b border-slate-200/80 sticky top-0 z-10 shadow-sm/50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          
          {/* Logo 及系统状态 */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-red-600 flex items-center justify-center text-white font-black text-sm shadow-md animate-pulse">
              量
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-slate-900 tracking-tight">转债量化辅助决策系统</h1>
                <span className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded border border-red-100 font-bold">A股标准</span>
              </div>
              <p className="text-xs text-slate-500">基于日内 VWAP 与 N周期布林偏离度实时监控</p>
            </div>
          </div>

          {/* 右侧自动刷新 & 强制重置状态栏 */}
          <div className="flex items-center gap-3 self-end sm:self-auto">
            <div className="text-right flex items-center gap-2 bg-slate-100/80 px-3 py-1.5 rounded-lg border border-slate-200">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              {tradingStatus?.trading ? (
                <span className="text-xs font-mono text-slate-600">
                  盘中交易 | 每 10 秒刷新：<strong className="text-slate-900 font-bold">{countdown}s</strong>
                </span>
              ) : (
                <span className="text-xs font-mono text-slate-500">
                  市场休市
                  {tradingStatus && (
                    <span className="text-slate-400 ml-1">({tradingStatus.session_label})</span>
                  )}
                  <span className="text-slate-400 ml-1">| 下轮检测：</span>
                  <strong className="text-slate-600 font-bold">{countdown}s</strong>
                </span>
              )}
              <span className="text-slate-300">|</span>
              <span className="text-xs text-slate-500 font-mono">
                更新: {lastUpdated || "--:--:--"}
              </span>
            </div>

            <button
              onClick={() => {
                fetchSignals(period, stdDev, false);
                setCountdown(10);
              }}
              title="立即同步信号"
              className="p-2 text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg hover:text-slate-950 hover:border-slate-300 transition-colors cursor-pointer flex items-center justify-center"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

        </div>
      </header>

      {/* 提示通知条：模拟器波动反馈 */}
      {shockMessage && (
        <div className="bg-red-50 border-b border-red-100 px-4 py-2.5 text-center text-xs text-red-700 font-medium flex items-center justify-center gap-2 animate-fadeIn">
          <Zap className="w-4 h-4 text-red-500 animate-bounce" />
          <span>{shockMessage}</span>
        </div>
      )}

      {/* 主体卡片与列表容器 */}
      <main className="max-w-6xl mx-auto px-4 py-6 flex flex-col gap-6">

        {/* 0. 顶部极简资产卡片看板 */}
        <section className="bg-slate-900 text-white rounded-2xl p-5 shadow-sm border border-slate-800">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4 mb-4">
            <div className="flex items-center gap-2.5">
              <Zap className="w-5 h-5 text-red-500 animate-pulse" />
              <div>
                <h2 className="text-sm font-bold text-slate-100 tracking-tight">量化模拟账户极简资产看板</h2>
                <p className="text-[11px] text-slate-400">实时反映模拟撮合交易下的动态可用余额、仓位估值与浮动损耗</p>
              </div>
            </div>
            
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400">执行机制:</span>
              {tradingStatus?.trading ? (
                <span className="flex items-center gap-1.5 font-bold text-green-400 bg-green-500/10 px-2.5 py-0.5 rounded border border-green-500/20">
                  <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></span>
                  T+0 实时撮合中
                </span>
              ) : (
                <span className="flex items-center gap-1.5 font-bold text-slate-400 bg-slate-500/10 px-2.5 py-0.5 rounded border border-slate-500/20">
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full"></span>
                  市场休市 | 仿真演示
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 divide-y sm:divide-y-0 sm:divide-x divide-slate-800">
            {/* 总资产 */}
            <div className="flex flex-col">
              <span className="text-xs text-slate-400 font-medium tracking-wide">总资产估值</span>
              <div className="flex items-baseline gap-1 mt-1.5">
                <span className="text-2xl font-black font-mono tracking-tight text-white leading-none">
                  {paperAccount ? paperAccount.total_assets.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "100,000.00"}
                </span>
                <span className="text-xs text-slate-500 font-medium">元</span>
              </div>
            </div>

            {/* 可用现金 */}
            <div className="sm:pl-6 pt-4 sm:pt-0 flex flex-col">
              <span className="text-xs text-slate-400 font-medium tracking-wide">可用现金</span>
              <div className="flex items-baseline gap-1 mt-1.5">
                <span className="text-2xl font-black font-mono tracking-tight text-slate-100 leading-none">
                  {paperAccount ? paperAccount.cash.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "100,000.00"}
                </span>
                <span className="text-xs text-slate-500 font-medium">元</span>
              </div>
            </div>

            {/* 持仓账面盈亏 */}
            <div className="sm:pl-6 pt-4 sm:pt-0 flex flex-col">
              <span className="text-xs text-slate-400 font-medium tracking-wide">当日持仓浮动盈亏</span>
              <div className="flex items-baseline gap-1 mt-1.5">
                {(() => {
                  const totalFloatingPnl = paperAccount?.positions?.reduce((sum: number, p: any) => sum + (p.pnl || 0), 0) || 0;
                  const isProfit = totalFloatingPnl >= 0;
                  return (
                    <>
                      <span className={`text-2xl font-black font-mono tracking-tight leading-none ${isProfit ? "text-red-500" : "text-emerald-500"}`}>
                        {isProfit ? "+" : ""}{totalFloatingPnl.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      <span className={`text-xs ${isProfit ? "text-red-500/80" : "text-emerald-500/80"} font-medium`}>元</span>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </section>

        {/* 1. 量化汇总统计看板 */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200/80 p-4 rounded-xl shadow-xs">
            <span className="text-xs text-slate-400 font-medium block">监控标的总数</span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-2xl font-bold text-slate-900 font-mono">{statCounts.total}</span>
              <span className="text-xs text-slate-500">只</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200/80 p-4 rounded-xl shadow-xs">
            <span className="text-xs text-red-500 font-semibold block flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping"></span>
              买入建议 (BUY_ZONE)
            </span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-2xl font-bold text-red-600 font-mono">{statCounts.buys}</span>
              <span className="text-xs text-slate-500">处</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200/80 p-4 rounded-xl shadow-xs">
            <span className="text-xs text-green-600 font-semibold block flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-ping"></span>
              卖出预警 (SELL_ZONE)
            </span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-2xl font-bold text-green-600 font-mono">{statCounts.sells}</span>
              <span className="text-xs text-slate-500">处</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200/80 p-4 rounded-xl shadow-xs">
            <span className="text-xs text-slate-400 font-medium block">平稳观望 (WAIT)</span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-2xl font-bold text-slate-600 font-mono">{statCounts.waits}</span>
              <span className="text-xs text-slate-500">只</span>
            </div>
          </div>
        </section>

        {/* 主工作区分割布局：左侧监控表格，右侧交易纪律打卡 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          
          {/* 左侧监控工作区 */}
          <div className="lg:col-span-2 flex flex-col gap-6">

            {/* 2. 交互操作栏 (整合搜索、过滤、以及小型调参面板) */}
            <section className="bg-white border border-slate-200/80 p-4 rounded-xl shadow-xs flex flex-col gap-4">
              
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                
                {/* 搜索与过滤选择 */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
                  
                  {/* 搜索框 */}
                  <div className="relative flex-1">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Search className="h-4 w-4 text-slate-400" />
                    </span>
                    <input
                      type="text"
                      placeholder="搜索可转债代码 / 名称..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="block w-full pl-9 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500 focus:bg-white transition-all"
                    />
                  </div>

                  {/* 信号状态过滤机制 */}
                  <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                    {(["ALL", "BUY_ZONE", "SELL_ZONE", "WAIT"] as const).map((tab) => {
                      const labelMap = { ALL: "全部", BUY_ZONE: "买入(红)", SELL_ZONE: "卖出(绿)", WAIT: "等待" };
                      const isActive = signalFilter === tab;
                      return (
                        <button
                          key={tab}
                          onClick={() => setSignalFilter(tab)}
                          className={`px-3 py-1 text-xs font-medium rounded-md transition-all cursor-pointer ${
                            isActive
                              ? "bg-white text-slate-950 shadow-xs border border-slate-200/30 font-semibold"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          {labelMap[tab]}
                        </button>
                      );
                    })}
                  </div>

                </div>

                {/* 参数调节 & 行情冲击快捷按钮 */}
                <div className="flex items-center gap-3 self-end lg:self-auto flex-wrap">
                  
                  {/* 参数调节切换按钮 */}
                  <button
                    onClick={() => setShowConfig(!showConfig)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                      showConfig 
                        ? "bg-red-50 text-red-600 border-red-200" 
                        : "bg-white text-slate-600 border-slate-200 hover:text-slate-900 hover:border-slate-300"
                    }`}
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    {showConfig ? "收起量化设置" : "调参设置"}
                    <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${showConfig ? "rotate-180" : ""}`} />
                  </button>

                  {/* 静默测试波动注入器 */}
                  <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 p-0.5 rounded-lg">
                    <span className="text-[10px] text-slate-400 font-mono px-2 hidden sm:inline">行情模拟:</span>
                    <button
                      onClick={() => handleSimulateShock("bull")}
                      title="模拟全场红色暴涨"
                      className="px-2 py-1 text-[10px] text-red-600 hover:bg-red-50 font-bold bg-white border border-slate-200 rounded cursor-pointer transition-colors"
                    >
                      多头拉
                    </button>
                    <button
                      onClick={() => handleSimulateShock("bear")}
                      title="模拟全场深绿大跌"
                      className="px-2 py-1 text-[10px] text-green-600 hover:bg-green-50 font-bold bg-white border border-slate-200 rounded cursor-pointer transition-colors"
                    >
                      空头碎
                    </button>
                    <button
                      onClick={() => handleSimulateShock("spike")}
                      title="模拟大震荡分化"
                      className="px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-100 font-bold bg-white border border-slate-200 rounded cursor-pointer transition-colors"
                    >
                      大震荡
                    </button>
                  </div>

                </div>

              </div>

              {/* Collapsible Panel: 精准算法微调参数区 */}
              {showConfig && (
                <div className="border-t border-slate-100 pt-4 mt-1 grid grid-cols-1 md:grid-cols-2 gap-4 animate-slideDown">
                  
                  {/* 布林带均线计算周期 */}
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 flex flex-col gap-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500 font-medium">布林带计算均值周期 (N-周期)</span>
                      <span className="text-red-500 font-mono font-bold">{period} 分钟线</span>
                    </div>
                    <input
                      type="range"
                      min="5"
                      max="60"
                      step="1"
                      value={period}
                      onChange={(e) => setPeriod(Number(e.target.value))}
                      className="w-full accent-red-600 cursor-pointer h-1 bg-slate-200 rounded border-none"
                    />
                    <div className="flex justify-between text-[9px] text-slate-400 font-mono">
                      <span>5m (高频抢跑)</span>
                      <span>20m (默认参数)</span>
                      <span>60m (过滤杂音)</span>
                    </div>
                  </div>

                  {/* 标准差倍数 */}
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 flex flex-col gap-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500 font-medium">波动通道带宽标准差倍数 (k-值)</span>
                      <span className="text-red-500 font-mono font-bold">±{stdDev.toFixed(1)}σ</span>
                    </div>
                    <input
                      type="range"
                      min="1.0"
                      max="3.0"
                      step="0.1"
                      value={stdDev}
                      onChange={(e) => setStdDev(Number(e.target.value))}
                      className="w-full accent-red-600 cursor-pointer h-1 bg-slate-200 rounded border-none"
                    />
                    <div className="flex justify-between text-[9px] text-slate-400 font-mono">
                      <span>1.0σ (窄带宽频繁)</span>
                      <span>2.0σ (经典模型)</span>
                      <span>3.0σ (严防极端)</span>
                    </div>
                  </div>

                </div>
              )}

            </section>

            {/* 3. 卡片式数据表格主体区域 (Primary Table) */}
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              
              <div className="overflow-x-auto">
                <table className="w-full table-fixed min-w-[700px]">
                  
                  {/* 表格标题头部栏 */}
                  <thead className="bg-slate-100/90 border-b border-slate-200 text-left text-slate-600 font-semibold text-xs tracking-wide">
                    <tr>
                      <th className="w-[18%] px-4 py-3 text-slate-700">标的名称 (及代码)</th>
                      <th className="w-[11%] px-4 py-3 text-slate-700">当前现价</th>
                      <th className="w-[11%] px-4 py-3 text-slate-700">日内 VWAP</th>
                      <th className="w-[23%] px-4 py-3 text-slate-700">操作信号 (A股红买绿卖)</th>
                      <th className="w-[21%] px-4 py-3 text-slate-700">建议执行价位</th>
                      <th className="w-[16%] px-4 py-3 text-slate-700">模拟操作</th>
                    </tr>
                  </thead>

                  {/* 表格实体填充 */}
                  <tbody className="divide-y divide-slate-100 text-sm">
                    
                    {loading ? (
                      <tr>
                        <td colSpan={6} className="py-16 text-center">
                          <div className="flex flex-col items-center justify-center gap-2 text-slate-400">
                            <RefreshCw className="w-6 h-6 animate-spin text-red-500" />
                            <span className="text-xs font-medium">正在拉取活跃可转债布林波动带判定序列...</span>
                          </div>
                        </td>
                      </tr>
                    ) : filteredBonds.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-16 text-center">
                          {connectionError ? (
                            <div className="flex flex-col items-center justify-center gap-2 text-slate-400">
                              <AlertCircle className="w-6 h-6 text-red-400" />
                              <span className="text-xs font-medium text-red-500">无法连接到量化分析后端服务</span>
                              <span className="text-[10px] text-slate-400">请确认后端服务器已启动 (如: npm run dev 或 python main.py)</span>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center justify-center gap-2 text-slate-400">
                              <span className="text-xs">未找到符合搜索或过滤条件的标的</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : (
                      filteredBonds.map((bond) => {
                        // 检查行是否需要呼吸动画高亮
                        const isBuy = bond.signal === "BUY_ZONE";
                        const isSell = bond.signal === "SELL_ZONE";
                        const rowHighlightClass = isBuy ? "row-alert-buy" : isSell ? "row-alert-sell" : "hover:bg-slate-50/70 transition-colors";

                        return (
                          <tr
                            key={bond.code}
                            className={`transition-all ${rowHighlightClass}`}
                          >
                            
                            {/* 1. 标的名称与代码 */}
                            <td className="px-4 py-3.5">
                              <div className="flex items-center gap-2">
                                <div>
                                  <span className="font-bold text-slate-900 block tracking-tight text-sm">
                                    {bond.name}
                                  </span>
                                  <span className="font-mono text-[10px] text-slate-400 font-semibold tracking-wider">
                                    {bond.code}
                                  </span>
                                </div>
                              </div>
                            </td>

                            {/* 2. 当前现价 */}
                            <td className="px-4 py-3.5">
                              <span className="font-mono font-bold text-slate-900 tracking-tight text-sm">
                                {bond.price.toFixed(3)}
                              </span>
                            </td>

                            {/* 3. 日内 VWAP */}
                            <td className="px-4 py-3.5">
                              <span className="font-mono text-slate-600 tracking-tight text-sm">
                                {bond.vwap.toFixed(3)}
                              </span>
                            </td>

                            {/* 4. 操作信号 (A股规范：上涨买入红，下跌卖出绿，等待灰) */}
                            <td className="px-4 py-3.5">
                              <div className="flex items-center gap-2 flex-wrap">
                                {bond.signal === "BUY_ZONE" ? (
                                  <span className="inline-flex items-center gap-1.5 bg-red-600 text-white font-black px-2.5 py-1 rounded text-xs shadow-xs border border-red-700/60 uppercase">
                                    <TrendingUp className="w-3.5 h-3.5" />
                                    BUY_ZONE (买入)
                                  </span>
                                ) : bond.signal === "SELL_ZONE" ? (
                                  <span className="inline-flex items-center gap-1.5 bg-emerald-600 text-white font-black px-2.5 py-1 rounded text-xs shadow-xs border border-emerald-700/60 uppercase">
                                    <TrendingDown className="w-3.5 h-3.5" />
                                    SELL_ZONE (卖出)
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-500 border border-slate-200/80 px-2.5 py-1 rounded text-xs font-semibold">
                                    WAIT (等待)
                                  </span>
                                )}

                                {/* 手动快速记录、纪律打卡按钮 */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleQuickLog(bond);
                                  }}
                                  title="一键带入右侧纪律打卡监控台"
                                  className="px-2 py-0.5 text-[11px] font-bold bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-950 border border-slate-200 hover:border-slate-300 rounded cursor-pointer transition-colors inline-flex items-center gap-0.5 shadow-2xs"
                                >
                                  <Plus className="w-3 h-3 text-slate-400" />
                                  打卡
                                </button>
                              </div>
                            </td>

                            {/* 5. 建议执行价位 */}
                            <td className="px-4 py-3.5">
                              {bond.signal === "BUY_ZONE" ? (
                                <div className="text-xs font-medium">
                                  <span className="text-red-600 font-bold block">
                                    建议买入价 &le; {bond.lower_band.toFixed(3)}
                                  </span>
                                  <span className="text-[10px] text-slate-400 font-mono">
                                    (现价跌透下阻力轨道)
                                  </span>
                                </div>
                              ) : bond.signal === "SELL_ZONE" ? (
                                <div className="text-xs font-medium">
                                  <span className="text-green-600 font-bold block">
                                    建议卖出价 &ge; {bond.upper_band.toFixed(3)}
                                  </span>
                                  <span className="text-[10px] text-slate-400 font-mono">
                                    (现价穿透阻力阻挠带)
                                  </span>
                                </div>
                              ) : (
                                <div className="text-xs text-slate-500 font-serif">
                                  <span className="font-mono text-slate-600 block">
                                    正常轨道: {bond.lower_band.toFixed(3)} - {bond.upper_band.toFixed(3)}
                                  </span>
                                  <span className="text-[9px] text-slate-400 block font-mono">
                                    (均价偏离标准未达阈值)
                                  </span>
                                </div>
                              )}
                            </td>

                            {/* 6. 模拟操作 */}
                            <td className="px-4 py-3.5">
                              {bond.signal === "BUY_ZONE" ? (
                                <button
                                  type="button"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const qty = Math.floor(10000 / bond.lower_band);
                                    if (qty <= 0) {
                                      showToast("下单资金不足购买1张，申报无效", "error");
                                      return;
                                    }
                                    await handleQuickTrade(bond.code, "BUY", bond.lower_band, qty);
                                  }}
                                  className="px-2.5 py-1 text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors cursor-pointer flex items-center justify-center gap-1 shadow-2xs select-none w-20"
                                >
                                  一键买入
                                </button>
                              ) : bond.signal === "SELL_ZONE" && posMap.has(bond.code) ? (
                                <button
                                  type="button"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const pos = posMap.get(bond.code);
                                    await handleQuickTrade(bond.code, "SELL", bond.upper_band, pos.amount);
                                  }}
                                  className="px-2.5 py-1 text-xs font-bold bg-indigo-650 hover:bg-indigo-700 text-white rounded-md transition-colors cursor-pointer flex items-center justify-center gap-1 shadow-2xs select-none w-20"
                                >
                                  一键清仓
                                </button>
                              ) : (
                                <span className="text-xs text-slate-400 font-mono">-</span>
                              )}
                            </td>

                          </tr>
                        );
                      })
                    )}

                  </tbody>
                </table>
              </div>

              {/* 表格底注说明 */}
              <div className="bg-slate-50/80 border-t border-slate-100 px-4 py-3 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-2">
                <span className="flex items-center gap-1.5">
                  <Info className="w-4 h-4 text-slate-400" />
                  <span>注：当最新价穿透下轨/上轨时触发买卖建议；点击【打卡】一键进行心理纪律与滑点记录测算。您可以直接使用新置的【模拟操作】一键买入/一键清仓进行全自动模拟盘投资。</span>
                </span>
                <span className="font-semibold text-slate-400 font-mono text-[10px]">
                  TOTAL COVERED BOLLINGER CHANNELS API
                </span>
              </div>

            </section>

            {/* 4. 底部的‘当前持仓’表格 */}
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              <div className="bg-slate-50 border-b border-slate-200 px-4 py-3.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="text-slate-500 w-4 h-4 ml-0.5" />
                  <h3 className="text-xs font-bold text-slate-800 tracking-tight">
                    当前模拟持仓组合状况
                  </h3>
                </div>
                <span className="text-[9px] text-slate-400 font-mono font-bold tracking-wider">
                  REAL-TIME PORTFOLIO TRACKING
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full table-fixed min-w-[700px]">
                  <thead className="bg-slate-100/50 border-b border-slate-200 text-left text-slate-600 font-semibold text-xs tracking-wide">
                    <tr>
                      <th className="w-1/4 px-4 py-2.5 text-slate-700">可转债简称与代码</th>
                      <th className="w-1/6 px-4 py-2.5 text-slate-700">持仓数量 (张)</th>
                      <th className="w-1/6 px-4 py-2.5 text-slate-700">持仓成本 (元)</th>
                      <th className="w-1/6 px-4 py-2.5 text-slate-700">当前现价 (元)</th>
                      <th className="w-1/5 px-4 py-2.5 text-slate-700">账面浮动盈亏额比</th>
                      <th className="w-1/6 px-4 py-2.5 text-slate-700">快捷操作</th>
                    </tr>
                  </thead>
                  
                  <tbody className="divide-y divide-slate-100 text-sm font-sans">
                    {!paperAccount || paperAccount.positions.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-10 text-center text-slate-400 text-xs">
                          名下暂无任何可转债持仓。在上方表格中，点击 <strong className="text-blue-600">一键买入</strong> 开启您的首笔投资。
                        </td>
                      </tr>
                    ) : (
                      paperAccount.positions.map((pos: any) => {
                        const isProfit = pos.pnl >= 0;
                        return (
                          <tr key={pos.symbol} className="hover:bg-slate-50/70 transition-colors">
                            {/* 标的代码与名称 */}
                            <td className="px-4 py-3">
                              <div>
                                <span className="font-bold text-slate-900 block text-xs">
                                  {pos.name}
                                </span>
                                <span className="font-mono text-[10px] text-slate-400 font-semibold tracking-wider">
                                  {pos.symbol}
                                </span>
                              </div>
                            </td>

                            {/* 持仓数量 */}
                            <td className="px-4 py-3 font-mono text-xs text-slate-800 font-bold">
                              {pos.amount} 张
                            </td>

                            {/* 持仓成本 */}
                            <td className="px-4 py-3 font-mono text-xs text-slate-800">
                              {pos.cost_price.toFixed(3)}
                            </td>

                            {/* 当前现价 */}
                            <td className="px-4 py-3 font-mono text-xs text-slate-800 font-bold">
                              {pos.current_price.toFixed(3)}
                            </td>

                            {/* 账面盈亏 / 比例 */}
                            <td className="px-4 py-3">
                              <div className="flex flex-col">
                                <span className={`font-mono text-xs font-bold ${isProfit ? "text-red-600" : "text-emerald-600"}`}>
                                  {isProfit ? "+" : ""}{pos.pnl.toFixed(2)} 元
                                </span>
                                <span className={`font-mono text-[10px] font-bold ${isProfit ? "text-red-500" : "text-emerald-500"}`}>
                                  ({isProfit ? "+" : ""}{pos.pnl_ratio.toFixed(2)}%)
                                </span>
                              </div>
                            </td>

                            {/* 快捷平仓 */}
                            <td className="px-4 py-3">
                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  // 按当前现价一键清仓
                                  await handleQuickTrade(pos.symbol, "SELL", pos.current_price, pos.amount);
                                }}
                                className="px-2.5 py-1 text-[11px] font-bold bg-white text-slate-700 border border-slate-200 hover:border-red-200 hover:text-red-600 rounded-md cursor-pointer transition-colors shadow-2xs"
                              >
                                一键清仓
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>

          </div>

          {/* 右侧交易纪律打卡控制台 */}
          <div className="lg:col-span-1 flex flex-col gap-6">
            
            {/* 标签页控制切换 */}
            <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200/80 font-medium select-none">
              <button
                onClick={() => setRightPanelTab("PAPER_ENGINE")}
                className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                  rightPanelTab === "PAPER_ENGINE"
                    ? "bg-white text-slate-900 shadow-xs border border-slate-200/40"
                    : "text-slate-500 hover:text-slate-900"
                }`}
              >
                <Zap className="w-3.5 h-3.5 text-red-500" />
                极简模拟盘 (T+0)
              </button>
              <button
                onClick={() => setRightPanelTab("DISCIPLINE_PUNCH")}
                className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                  rightPanelTab === "DISCIPLINE_PUNCH"
                    ? "bg-white text-slate-900 shadow-xs border border-slate-200/40"
                    : "text-slate-500 hover:text-slate-900"
                }`}
              >
                <Target className="w-3.5 h-3.5 text-slate-600" />
                交易纪律打卡
              </button>
            </div>

            {rightPanelTab === "PAPER_ENGINE" ? (
              /* 模拟盘引擎模块 */
              <div className="flex flex-col gap-5">
                
                {/* 1. 模拟账户总览 */}
                <div className="bg-slate-900 text-white rounded-xl p-5 shadow-sm flex flex-col gap-3 border border-slate-800">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">量化模拟交易账户</span>
                    <span className="flex items-center gap-1 text-[10px] text-red-400 font-bold bg-red-500/10 px-1.5 py-0.5 rounded border border-red-500/20">
                      <span className="w-1.5 h-1.5 bg-red-400 rounded-full animate-pulse"></span>
                      万二佣金
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2 text-center my-0.5">
                    <div>
                      <span className="block text-[10px] text-slate-400">总资产 (元)</span>
                      <span className="font-mono text-sm font-black tracking-tight text-slate-100">
                        {paperAccount ? paperAccount.total_assets.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "100,000.00"}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-slate-400">可用现金 (元)</span>
                      <span className="font-mono text-sm font-black tracking-tight text-white">
                        {paperAccount ? paperAccount.cash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "100,000.00"}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-slate-400">持仓市值 (元)</span>
                      <span className="font-mono text-sm font-black tracking-tight text-slate-200">
                        {paperAccount ? paperAccount.market_value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00"}
                      </span>
                    </div>
                  </div>

                  {/* 重置回10万快捷按钮 */}
                  <div className="flex justify-end pt-1 border-t border-slate-800/80 mt-1">
                    {!confirmReset ? (
                      <button
                        onClick={() => setConfirmReset(true)}
                        className="text-[10px] text-slate-400 hover:text-red-400 transition-colors font-semibold cursor-pointer"
                      >
                        一键账户重置
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 text-[10px] animate-fadeIn">
                        <span className="text-red-400 font-bold">确定清空持仓并归零10万？</span>
                        <button onClick={handlePaperReset} className="bg-red-600 text-white px-2 py-0.5 rounded font-black hover:bg-red-700 cursor-pointer">是</button>
                        <button onClick={() => setConfirmReset(false)} className="text-slate-400 font-semibold hover:text-white cursor-pointer">取消</button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 2. 模拟申报舱 */}
                <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <div className="flex items-center gap-2">
                      <Zap className="w-5 h-5 text-red-600" />
                      <div>
                        <h3 className="text-sm font-bold text-slate-950">模拟申报舱</h3>
                        <p className="text-[11px] text-slate-400">自动市价快速挂单撮合结算机制</p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3.5">
                    {/* 选择标的 */}
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">交易标的</label>
                      <select
                        value={selectedBondCode}
                        onChange={(e) => {
                          setSelectedBondCode(e.target.value);
                          const found = signals.find(s => s.code === e.target.value);
                          if (found) {
                            const type = found.signal === "SELL_ZONE" ? "SELL" : "BUY";
                            setTradeType(type);
                            setSuggestedPrice(type === "BUY" ? found.lower_band : found.upper_band);
                            setActualPrice(found.price.toString());
                          }
                        }}
                        className="block w-full py-1.5 px-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-red-500 text-slate-900"
                      >
                        {signals.length === 0 ? (
                          <option>加载中...</option>
                        ) : (
                          signals.map((b) => (
                            <option key={b.code} value={b.code}>
                              {b.name} ({b.code}) [现价: {b.price.toFixed(3)}]
                            </option>
                          ))
                        )}
                      </select>
                    </div>

                    {/* 买卖切换与数量 */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-500 mb-1">模拟方向</label>
                        <div className="flex rounded-lg bg-slate-100 p-0.5 border border-slate-200">
                          <button
                            type="button"
                            onClick={() => {
                              setTradeType("BUY");
                              const found = signals.find(s => s.code === selectedBondCode);
                              if (found) setSuggestedPrice(found.lower_band);
                            }}
                            className={`flex-1 text-center py-1 rounded text-xs font-bold transition-all cursor-pointer ${
                              tradeType === "BUY" ? "bg-red-600 text-white shadow-xs" : "text-slate-500"
                            }`}
                          >
                            买入 (BUY)
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setTradeType("SELL");
                              const found = signals.find(s => s.code === selectedBondCode);
                              if (found) setSuggestedPrice(found.upper_band);
                            }}
                            className={`flex-1 text-center py-1 rounded text-xs font-bold transition-all cursor-pointer ${
                              tradeType === "SELL" ? "bg-emerald-600 text-white shadow-xs" : "text-slate-500"
                            }`}
                          >
                            卖出 (SELL)
                          </button>
                        </div>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-500 mb-1">申报数量 (张)</label>
                        <input
                          type="number"
                          min="1"
                          placeholder="张数"
                          value={tradeQuantity}
                          onChange={(e) => setTradeQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                          className="block w-full py-1.5 px-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-red-500 text-right text-slate-900"
                        />
                      </div>
                    </div>

                    {/* 设定价格 */}
                    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200/50 flex flex-col gap-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-500 font-medium">申报价格 (元/张)：</span>
                        <div className="relative w-32">
                          <input
                            type="text"
                            value={actualPrice}
                            onChange={(e) => setActualPrice(e.target.value)}
                            placeholder="均价"
                            className="block w-full py-1 pl-2 pr-5 bg-white border border-slate-300 rounded text-xs text-right font-mono font-black text-slate-900 focus:outline-none focus:border-red-500"
                          />
                          <span className="absolute inset-y-0 right-1.5 flex items-center text-[10px] text-slate-400 pointer-events-none">元</span>
                        </div>
                      </div>

                      {/* 资金需求估值 */}
                      {parseFloat(actualPrice) > 0 && (
                        <div className="border-t border-slate-200/60 pt-2 flex flex-col gap-1 text-[10px] text-slate-500 font-medium font-mono">
                          <div className="flex justify-between">
                            <span>交易估算市值:</span>
                            <span className="text-slate-800">{(parseFloat(actualPrice) * tradeQuantity).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元</span>
                          </div>
                          <div className="flex justify-between">
                            <span>扣减万二佣金:</span>
                            <span className="text-slate-800">{(parseFloat(actualPrice) * tradeQuantity * 0.0002).toFixed(2)} 元</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 状态通知 */}
                    {tradeStatusMessage && (
                      <div className={`p-2.5 rounded text-xs leading-snug font-medium border ${
                        tradeStatusMessage.type === "success"
                          ? "bg-green-50 text-green-800 border-green-100"
                          : "bg-red-50 text-red-800 border-red-100"
                      }`}>
                        {tradeStatusMessage.text}
                      </div>
                    )}

                    {/* 申报按钮 */}
                    <button
                      onClick={() => handlePaperTradeSubmit()}
                      disabled={paperTradeLoading || !actualPrice || parseFloat(actualPrice) <= 0}
                      className="w-full py-2 bg-slate-900 hover:bg-slate-950 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    >
                      {paperTradeLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      递交申报指令 (T+0)
                    </button>
                    
                  </div>
                </div>

                {/* 3. 模拟持仓池 */}
                <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-3">
                  <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                    <Layers className="w-5 h-5 text-slate-500" />
                    <h3 className="text-sm font-bold text-slate-950">当前持仓组合 ({paperAccount?.positions?.length || 0})</h3>
                  </div>

                  <div className="flex flex-col gap-3 max-h-[350px] overflow-y-auto pr-1">
                    {!paperAccount || paperAccount.positions.length === 0 ? (
                      <div className="text-center py-12 text-slate-400 text-xs">
                        <p>名下暂无任何可转债持仓</p>
                        <p className="text-[10px] text-slate-400 mt-1">请在上方对准买卖建议区报入来启动您的首笔模拟单</p>
                      </div>
                    ) : (
                      paperAccount.positions.map((pos: any) => {
                        const isProfit = pos.pnl >= 0;
                        return (
                          <div key={pos.symbol} className="bg-slate-50/85 hover:bg-slate-100/60 border border-slate-200/50 rounded-xl p-3 flex flex-col gap-2 transition-all">
                            <div className="flex justify-between items-start">
                              <div>
                                <span className="font-bold text-slate-900 text-xs block">{pos.name}</span>
                                <span className="font-mono text-[9px] text-slate-400 font-bold tracking-wider">{pos.symbol}</span>
                              </div>
                              <span className={`font-mono text-[10px] font-black rounded-sm px-1.5 py-0.5 border ${
                                isProfit 
                                  ? "bg-red-50 text-red-600 border-red-100" 
                                  : "bg-emerald-50 text-emerald-600 border-emerald-100"
                              }`}>
                                {isProfit ? "+" : ""}{pos.pnl_ratio.toFixed(2)}%
                              </span>
                            </div>

                            <div className="grid grid-cols-2 gap-y-1.5 gap-x-2 text-[10px] text-slate-500 font-mono pt-1.5 border-t border-slate-200/40">
                              <div className="flex justify-between">
                                <span>持仓数量:</span>
                                <span className="text-slate-800 font-bold">{pos.amount} 张</span>
                              </div>
                              <div className="flex justify-between">
                                <span>摊薄成本:</span>
                                <span className="text-slate-800 font-bold">{pos.cost_price.toFixed(3)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span>当前现价:</span>
                                <span className="text-slate-800 font-bold">{pos.current_price.toFixed(3)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span>账面浮盈:</span>
                                <span className={`font-bold ${isProfit ? "text-red-600" : "text-emerald-600"}`}>
                                  {isProfit ? "+" : ""}{pos.pnl.toFixed(2)} 元
                                </span>
                              </div>
                            </div>

                            {/* 带入平仓快捷卖出按钮 */}
                            <div className="flex gap-2 justify-end mt-1 pt-2 border-t border-dashed border-slate-200/60">
                              <button
                                onClick={() => {
                                  setSelectedBondCode(pos.symbol);
                                  setTradeType("SELL");
                                  setTradeQuantity(pos.amount);
                                  setActualPrice(pos.current_price.toString());
                                }}
                                className="text-[10px] font-bold text-slate-500 hover:text-slate-900 bg-white border border-slate-200 px-2 py-0.5 rounded cursor-pointer shadow-2xs hover:bg-slate-50"
                              >
                                快速带入申报平仓
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

              </div>
            ) : (
              /* 交易纪律打卡面板 */
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-4">
                <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                  <Target className="w-5 h-5 text-red-600" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-950">交易纪律打卡</h3>
                    <p className="text-[11px] text-slate-400">手动成交后归档，自动测算滑点偏差</p>
                  </div>
                </div>

                <form onSubmit={handleAddLog} className="flex flex-col gap-3.5">
                  
                  {/* 选择标的 */}
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500 mb-1">交易标的</label>
                    <select
                      value={selectedBondCode}
                      onChange={(e) => {
                        setSelectedBondCode(e.target.value);
                        const found = signals.find(s => s.code === e.target.value);
                        if (found) {
                          const type = found.signal === "SELL_ZONE" ? "SELL" : "BUY";
                          setTradeType(type);
                          setSuggestedPrice(type === "BUY" ? found.lower_band : found.upper_band);
                          setActualPrice(found.price.toString());
                        }
                      }}
                      className="block w-full py-1.5 px-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-red-500 text-slate-900"
                    >
                      {signals.length === 0 ? (
                        <option>加载中...</option>
                      ) : (
                        signals.map((b) => (
                          <option key={b.code} value={b.code}>
                            {b.name} ({b.code}) [现价: {b.price.toFixed(3)}]
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  {/* 交易类型与数量 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">交易动作</label>
                      <div className="flex rounded-lg bg-slate-100 p-0.5 border border-slate-200">
                        <button
                          type="button"
                          onClick={() => {
                            setTradeType("BUY");
                            const found = signals.find(s => s.code === selectedBondCode);
                            if (found) {
                              setSuggestedPrice(found.lower_band);
                            }
                          }}
                          className={`flex-1 text-center py-1 rounded text-xs font-bold transition-all cursor-pointer ${
                            tradeType === "BUY" ? "bg-red-600 text-white shadow-xs" : "text-slate-500"
                          }`}
                        >
                          买入 (BUY)
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTradeType("SELL");
                            const found = signals.find(s => s.code === selectedBondCode);
                            if (found) {
                              setSuggestedPrice(found.upper_band);
                            }
                          }}
                          className={`flex-1 text-center py-1 rounded text-xs font-bold transition-all cursor-pointer ${
                            tradeType === "SELL" ? "bg-emerald-600 text-white shadow-xs" : "text-slate-500"
                          }`}
                        >
                          卖出 (SELL)
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">成交数量 (张)</label>
                      <input
                        type="number"
                        min="1"
                        placeholder="张数"
                        value={tradeQuantity}
                        onChange={(e) => setTradeQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                        className="block w-full py-1.5 px-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-red-500 text-right text-slate-900"
                      />
                    </div>
                  </div>

                  {/* 比对分析数据：建议价 vs 实际价 */}
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200/50 flex flex-col gap-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500 font-medium">量化建议价位：</span>
                      <span className={`font-mono font-bold ${tradeType === "BUY" ? "text-red-600" : "text-emerald-600"}`}>
                        {tradeType === "BUY" ? "建议下轨 ≤ " : "建议上轨 ≥ "}
                        {suggestedPrice.toFixed(3)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500 font-medium">实盘实际成交价：</span>
                      <div className="relative w-32">
                        <input
                          type="text"
                          value={actualPrice}
                          onChange={(e) => setActualPrice(e.target.value)}
                          placeholder="实际均价"
                          className="block w-full py-1 pl-2 pr-5 bg-white border border-slate-300 rounded text-xs text-right font-mono font-black text-slate-900 focus:outline-none focus:border-red-500"
                        />
                        <span className="absolute inset-y-0 right-1.5 flex items-center text-[10px] text-slate-400 pointer-events-none">元</span>
                      </div>
                    </div>

                    {/* 滑点实时测算评价 */}
                    {parseFloat(actualPrice) > 0 && suggestedPrice > 0 && (
                      <div className="border-t border-slate-200/80 pt-2 mt-1">
                        <div className="flex justify-between items-center mb-1 text-xs">
                          <span className="text-slate-500 font-medium">摩擦滑点差：</span>
                          <span className={`font-mono font-bold ${slippageCalculation.isPerfect ? "text-red-600" : "text-amber-600"}`}>
                            {slippageCalculation.slippagePerUnit > 0 ? "+" : ""}
                            {slippageCalculation.slippagePerUnit.toFixed(3)} 元/张
                          </span>
                        </div>
                        <div className={`text-[11px] p-2 rounded leading-snug font-medium border ${
                          slippageCalculation.isPerfect 
                            ? "bg-red-50/50 text-red-700 border-red-100" 
                            : "bg-amber-50 text-amber-800 border-amber-100"
                        }`}>
                          {slippageCalculation.message}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 提交按钮 */}
                  <button
                    type="submit"
                    disabled={!actualPrice || parseFloat(actualPrice) <= 0}
                    className="w-full py-2 bg-slate-900 hover:bg-slate-950 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                  >
                    <Plus className="w-4 h-4" />
                    提交打卡记录
                  </button>

                </form>
              </div>
            )}

            {/* 2. 个人量化纪律日志归档历史 */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <BookOpen className="w-5 h-5 text-slate-500" />
                  <h3 className="text-sm font-bold text-slate-950">历史实盘日志</h3>
                </div>
                {tradeLogs.length > 0 && (
                  <div className="relative">
                    {!confirmClear ? (
                      <button
                        onClick={() => setConfirmClear(true)}
                        className="text-[10px] font-bold text-slate-400 hover:text-red-500 hover:bg-red-50 px-1.5 py-0.5 rounded cursor-pointer transition-all border border-slate-200/80"
                      >
                        清空
                      </button>
                    ) : (
                      <div className="flex items-center gap-1 animate-fadeIn text-[10px]">
                        <button
                          onClick={handleClearLogs}
                          className="bg-red-600 text-white font-bold px-1.5 py-0.5 rounded cursor-pointer"
                        >
                          确定
                        </button>
                        <button
                          onClick={() => setConfirmClear(false)}
                          className="bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded cursor-pointer"
                        >
                          取消
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 历史卡片列表 */}
              <div className="flex flex-col gap-3 max-h-[350px] overflow-y-auto pr-1">
                {tradeLogs.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 text-xs">
                    <p>尚无任何纪律打卡日志</p>
                    <p className="text-[10px] text-slate-300 mt-1">在大表行中点击【打卡】自动填充记录</p>
                  </div>
                ) : (
                  tradeLogs.map((log) => (
                    <div
                      key={log.id}
                      className={`border p-3.5 rounded-lg text-xs flex flex-col gap-1.5 transition-all relative group ${
                        log.isPerfect 
                          ? "bg-slate-50/50 border-slate-100 hover:border-red-200 hover:bg-red-50/10" 
                          : "bg-red-50/10 border-red-100 hover:bg-red-50/25"
                      }`}
                    >
                      {/* 删除单条 */}
                      <button
                        onClick={() => handleDeleteLog(log.id)}
                        className="absolute top-2 right-2 p-1 text-slate-400 hover:text-red-600 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        title="删除日志"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>

                      <div className="flex items-center justify-between font-bold">
                        <span className="text-slate-900 group-hover:text-red-700 transition-colors">
                          {log.name} <span className="font-mono text-[10px] text-slate-400">({log.code})</span>
                        </span>
                        <span className="font-mono text-[10px] text-slate-400 font-normal">{log.timestamp}</span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-500 font-mono">
                        <div>
                          动作：
                          <span className={`font-semibold ${log.type === "BUY" ? "text-red-600" : "text-green-600"}`}>
                            {log.type === "BUY" ? "买入 (BUY)" : "卖出 (SELL)"}
                          </span>
                        </div>
                        <div className="text-right">数量：{log.quantity} 张</div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-[10.5px] font-mono border-t border-dashed border-slate-200/80 pt-1.5">
                        <div className="text-slate-500">
                          建议价格：<strong className="text-slate-700 font-bold">{log.suggestedPrice.toFixed(3)}</strong>
                        </div>
                        <div className="text-right text-slate-500">
                          实际价格：<strong className="text-slate-900 font-black">{log.actualPrice.toFixed(3)}</strong>
                        </div>
                      </div>

                      {/* 滑点成本展示 */}
                      <div className="flex items-center gap-1 text-[11px] font-medium leading-relaxed bg-white/70 border border-slate-100 p-1.5 rounded mt-0.5">
                        {log.isPerfect ? (
                          <span className="text-red-600 font-bold block">
                            💡 {log.verdict}
                          </span>
                        ) : (
                          <span className="text-amber-850 font-semibold block">
                            ⚠️ 滑点磨损：量化亏损约为{log.slippageTotal.toFixed(2)} 元 ({log.slippagePerUnit.toFixed(3)}/张)
                          </span>
                        )}
                      </div>

                    </div>
                  ))
                )}
              </div>
            </div>

          </div>

        </div>

      </main>

      {/* Toast 提示反馈 */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 transform translate-y-0 transition-all flex items-center gap-2 px-4 py-3.5 rounded-xl shadow-lg border text-xs max-w-sm font-medium animate-fadeIn ${
          toast.type === "success" 
            ? "bg-green-50 text-green-800 border-green-200" 
            : "bg-red-50 text-red-800 border-red-200"
        }`}>
          {toast.type === "success" ? <Check className="w-4 h-4 text-green-600 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 animate-bounce" />}
          <span>{toast.text}</span>
        </div>
      )}

      {/* 极简页脚 */}
      <footer className="mt-12 border-t border-slate-200/60 bg-white py-6">
        <div className="max-w-6xl mx-auto px-4 text-center text-xs text-slate-400">
          <p>© 2026 可转债极简量化辅助决策工作台. 均服务于高频看盘交易决策.</p>
        </div>
      </footer>
    </div>
  );
}
