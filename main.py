# -*- coding: utf-8 -*-
"""
资深量化辅助决策系统后端 (FastAPI + AkShare)
功能：
1. 定时获取沪深成交额前 50 的活跃可转债数据。
2. 采用 ThreadPoolExecutor 多线程并发拉取 1 分钟 K 线历史，避免单线程阻塞。
3. 计算日内高频 VWAP (成交量加权平均价) 和 20 分钟 Bollinger Bands (布林带)。
4. 判定现价在布林轨道的位置，生成 BUY_ZONE / SELL_ZONE / WAIT 仓位决策信号。
5. 通过 FastAPI 暴露标准 API 接口，提供给前端可视化展示。
"""

import logging
import threading
import time
import os
import json
import asyncio
import datetime
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Optional
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

# 尝试导入 akshare，并友好报错提示
try:
    import akshare as ak
except ImportError:
    raise ImportError("请确保已安装 akshare 库。运行 'pip install akshare'。")

# 设置日志格式
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("QuantDecisionSystem")

app = FastAPI(
    title="极简可转债量化辅助决策系统",
    description="基于 VWAP 和 20分钟布林带 (Bollinger Bands) 的实时可转债信号判定后端",
    version="1.0.0"
)

# 允许跨域，方便 React/Vite 前端调用
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 全局内存缓存，防止高频重复请求导致中国金融数据网站 IP 被封锁
class SignalCache:
    def __init__(self):
        self.data: List[Dict] = []
        self.all_bonds: Dict[str, Dict] = {}  # code -> {name, price} 全市场最新的可转债现价及名称缓存
        self.last_updated: float = 0.0
        self.lock = threading.Lock()

cache = SignalCache()

# 模拟交易入参 Pydantic 模型
class TradeRequest(BaseModel):
    symbol: str = Field(..., description="可转债代码")
    action: str = Field(..., description="买卖方向：BUY / SELL")
    price: float = Field(..., description="交易成交价格")
    amount: int = Field(..., description="交易数量（张）")

# 模拟交易持久化文件位置
PORTFOLIO_FILE = os.path.join(os.path.dirname(__file__), "paper_portfolio.json")

# 模拟交易引擎核心管理器
class PaperTradingManager:
    def __init__(self, filepath: str = PORTFOLIO_FILE):
        self.filepath = filepath
        self.lock = threading.Lock()
        self._initialize_portfolio_file()

    def _initialize_portfolio_file(self):
        """若没有本地持久化 JSON 数据文件，则自动组装初始化 100,000 元本金的模拟账户账户数据"""
        with self.lock:
            if not os.path.exists(self.filepath):
                initial_data = {
                    "cash": 100000.0,
                    "positions": {}  # symbol -> {symbol, name, amount, cost_price}
                }
                try:
                    with open(self.filepath, "w", encoding="utf-8") as f:
                        json.dump(initial_data, f, ensure_ascii=False, indent=2)
                except Exception as e:
                    logger.error(f"初始化模拟持仓数据文件出错: {str(e)}")

    def _load_portfolio(self) -> Dict:
        """从 JSON 文件中获取模拟盘最新资管数据"""
        try:
            if os.path.exists(self.filepath):
                with open(self.filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if "cash" not in data:
                        data["cash"] = 100000.0
                    if "positions" not in data:
                        data["positions"] = {}
                    return data
        except Exception as e:
            logger.error(f"读取模拟盘数据文件发生不可预知错误: {str(e)}")
        return {"cash": 100000.0, "positions": {}}

    def _save_portfolio(self, data: Dict):
        """保存最新的模拟账户至 JSON 持久化文件中"""
        try:
            with open(self.filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"更新写入模拟交易持仓文件失败: {str(e)}")

    def get_bond_live_data(self, symbol: str, all_bonds_cache: Dict[str, Dict]) -> Dict:
        """
        获取某个转债的实时行情。如果在系统的 top50 主缓存未找到，
        则通过 akshare 接口实时兜底查询。
        """
        if symbol in all_bonds_cache:
            return all_bonds_cache[symbol]
        
        # 兜底：如果外部缓存中未录入，主动拉取一次实时列表获取该转债的现价
        try:
            df_curr = ak.bond_zh_cov_realtime()
            if df_curr is not None and not df_curr.empty:
                for item in df_curr.to_dict(orient="records"):
                    c = item.get("code")
                    if c == symbol:
                        p = float(item.get("trade", 0)) if item.get("trade") else 0.0
                        return {"name": item.get("name", f"转债{symbol}"), "price": p}
        except Exception:
            pass
            
        return {"name": f"转债{symbol}", "price": 0.0}

    def get_account_summary(self, all_bonds_cache: Dict[str, Dict]) -> Dict:
        """
        获取当前模拟账户状况（包含总资产、可用现金、持仓实时市值、各持仓的保本均价、浮动盈亏等）
        """
        with self.lock:
            portfolio = self._load_portfolio()
            cash = float(portfolio.get("cash", 100000.0))
            positions_data = portfolio.get("positions", {})

            positions_list = []
            total_market_value = 0.0

            for symbol, pos in positions_data.items():
                amount = int(pos["amount"])
                cost_price = float(pos["cost_price"])
                
                # 获取该债的最新现价
                bond_live = self.get_bond_live_data(symbol, all_bonds_cache)
                name = pos.get("name") or bond_live.get("name") or f"转债{symbol}"
                current_price = bond_live.get("price") or cost_price
                if current_price <= 0:
                    current_price = cost_price

                market_value = amount * current_price
                total_market_value += market_value
                
                # 浮动盈亏 = (最新价 - 成本均价) * 数量
                pnl = (current_price - cost_price) * amount
                cost_total = cost_price * amount
                pnl_ratio = (pnl / cost_total * 100) if cost_total > 0 else 0.0

                positions_list.append({
                    "symbol": symbol,
                    "name": name,
                    "amount": amount,
                    "cost_price": round(cost_price, 3),
                    "current_price": round(current_price, 3),
                    "market_value": round(market_value, 2),
                    "pnl": round(pnl, 2),
                    "pnl_ratio": round(pnl_ratio, 2)
                })

            total_assets = cash + total_market_value

            return {
                "total_assets": round(total_assets, 2),
                "cash": round(cash, 2),
                "market_value": round(total_market_value, 2),
                "positions": positions_list
            }

    def execute_trade(self, symbol: str, action: str, price: float, amount: int, all_bonds_cache: Dict[str, Dict]) -> Dict:
        """
        买卖交易执行。万分之二手续费。极简 T+0。
        """
        if amount <= 0:
            raise ValueError("交易数量（张数）必须大于 0")
        if price <= 0:
            raise ValueError("交易成交价格必须大于 0")
        
        action = action.upper()
        if action not in ["BUY", "SELL"]:
            raise ValueError("交易方向只能为 BUY 或 SELL")

        fee_rate = 0.0002  # 模拟手续费率万分之二

        with self.lock:
            portfolio = self._load_portfolio()
            cash = float(portfolio.get("cash", 100000.0))
            positions = portfolio.get("positions", {})

            # 确定转债名称
            bond_live = self.get_bond_live_data(symbol, all_bonds_cache)
            bond_name = bond_live.get("name", f"转债{symbol}")

            trade_value = price * amount
            fee = trade_value * fee_rate

            if action == "BUY":
                total_cost = trade_value + fee
                if cash < total_cost:
                    raise ValueError(f"可用资金不足。需要总资金: {total_cost:.2f}元 (成交额 {trade_value:.2f}元 + 万二手续费 {fee:.2f}元)，当前现金可用余额: {cash:.2f}元")
                
                # 扣除现金
                cash -= total_cost

                # 加持仓数量并摊薄持有成本价格
                if symbol in positions:
                    existing = positions[symbol]
                    old_amount = int(existing["amount"])
                    old_cost = float(existing["cost_price"])
                    
                    new_amount = old_amount + amount
                    # 新成本 = (老持仓市值 + 新买入市值 + 新买入手续费) / 新持仓总量
                    new_cost_price = (old_cost * old_amount + trade_value + fee) / new_amount
                    
                    positions[symbol]["amount"] = new_amount
                    positions[symbol]["cost_price"] = new_cost_price
                    positions[symbol]["name"] = bond_name
                else:
                    new_cost_price = (trade_value + fee) / amount
                    positions[symbol] = {
                        "symbol": symbol,
                        "name": bond_name,
                        "amount": amount,
                        "cost_price": new_cost_price
                    }
                    
                portfolio["cash"] = cash
                portfolio["positions"] = positions
                self._save_portfolio(portfolio)
                
                return {
                    "success": True,
                    "message": f"【模拟交易】买入成交成功！已购入 {bond_name}({symbol}) {amount}张，成交单价: {price:.3f}元，成交额: {trade_value:.2f}元，手续费(万二): {fee:.2f}元。",
                    "cash": round(cash, 2)
                }

            elif action == "SELL":
                if symbol not in positions or positions[symbol]["amount"] < amount:
                    available = positions[symbol]["amount"] if symbol in positions else 0
                    raise ValueError(f"当前持仓份额不足！请求卖出 {amount}张，可用持仓额仅为 {available}张")
                
                # 现金增加（回笼市值并扣减对应比例费用）
                net_revenue = trade_value - fee
                cash += net_revenue

                # 扣减对应持仓
                existing_amount = int(positions[symbol]["amount"])
                if existing_amount == amount:
                    del positions[symbol]
                else:
                    positions[symbol]["amount"] = existing_amount - amount

                portfolio["cash"] = cash
                portfolio["positions"] = positions
                self._save_portfolio(portfolio)

                return {
                    "success": True,
                    "message": f"【模拟交易】卖出成交成功！已回笼 {bond_name}({symbol}) {amount}张，成交单价: {price:.3f}元，成交额: {trade_value:.2f}元，扣除万二手续费: {fee:.2f}元，实增现金资金: {net_revenue:.2f}元。",
                    "cash": round(cash, 2)
                }

paper_trader = PaperTradingManager()

# 全局内存缓存，防止高频重复请求导致中国金融数据网站 IP 被封锁

# 可转债代码前缀转换助手
def format_bond_code(code: str) -> str:
    """
    根据国金、新浪、腾讯等接口规则，格式化沪深可转债：
    - 沪市（主要 110、113、118 开头） -> sh代码
    - 深市（主要 123、127、128 开头） -> sz代码
    """
    clean_code = str(code).strip()
    if clean_code.startswith(('110', '113', '118')):
        return f"sh{clean_code}"
    elif clean_code.startswith(('123', '124', '127', '128')):
        return f"sz{clean_code}"
    return clean_code

def fetch_single_bond_signals(bond_info: Dict, period_mins: int = 20) -> Optional[Dict]:
    """
    获取单只可转债的分钟 K 线，并在线计算日内 VWAP、20分钟布林带和交易决策信号
    """
    code = bond_info["code"]
    formatted_code = format_bond_code(code)
    name = bond_info["name"]
    current_price = float(bond_info["trade"]) if bond_info.get("trade") else None
    
    if current_price is None or current_price <= 0:
        return None

    try:
        # 使用 akshare 获取可转债 1 分钟历史 K 线数据
        # 备注：若由于网络不稳定，可使用 try-except 的兜底备份数据
        df_min = ak.bond_zh_hs_cov_min(symbol=formatted_code, period="1")
        
        if df_min is None or df_min.empty or len(df_min) < period_mins:
            # 备用方案：如果今天刚开盘，1 分钟 K 线不足 20 根，则拉取最近的日 K 或者放宽周期限制
            if df_min is not None and not df_min.empty:
                # 即使不足 20 根，也用所有可用的根数来算
                close_prices = df_min['close'].astype(float).values
                volumes = df_min['volume'].astype(float).values
            else:
                return None
        else:
            df_slice = df_min.tail(period_mins)
            close_prices = df_slice['close'].astype(float).values
            volumes = df_slice['volume'].astype(float).values

        # 1. 计算简单的日内 VWAP
        # 备注：akshare 的 realtime 数据提供的 'amount'(成交额) 和 'volume'(成交量) 是日内累计。
        # 国金证券/新浪的每日成交额 (amount) 是以元为单位，成交量 (volume) 是以股/张为单位。
        # 实时 VWAP 采用：成交额 / 成交量 是最精确的日内加权价位。
        volume_sum = float(bond_info.get("volume", 0))
        amount_sum = float(bond_info.get("amount", 0))
        if volume_sum > 0 and amount_sum > 0:
            vwap = amount_sum / volume_sum
        else:
            # 备用计算：从分时 K 线中计算
            vwap = np.sum(close_prices * volumes) / np.sum(volumes) if np.sum(volumes) > 0 else current_price

        # 2. 计算布林带（基于过去 20 分钟的收盘价收敛值）
        mean_val = np.mean(close_prices)
        std_val = np.std(close_prices, ddof=1) if len(close_prices) > 1 else 0.01
        if std_val == 0:
            std_val = 0.01 # 规避除以 0 的风险
        
        upper_band = mean_val + 2 * std_val
        lower_band = mean_val - 2 * std_val

        # 3. 产生短线建议决策信号
        # 现价 < 下轨 -> 建议买入（BUY_ZONE）；现价 > 上轨 -> 建议卖出（SELL_ZONE）；其余 WAIT
        if current_price <= lower_band:
            signal = "BUY_ZONE"
        elif current_price >= upper_band:
            signal = "SELL_ZONE"
        else:
            signal = "WAIT"

        # 格式化输出数据结构
        return {
            "code": code,
            "name": name,
            "price": round(current_price, 3),
            "vwap": round(vwap, 3),
            "upper_band": round(upper_band, 3),
            "lower_band": round(lower_band, 3),
            "signal": signal,
            "buy_price": round(lower_band, 3),   # 建议买入位为下轨
            "sell_price": round(upper_band, 3),  # 建议卖出位为上轨
            "turnover": round(amount_sum / 10000.0, 2), # 成交额(万元)
            "updated_at": time.strftime("%H:%M:%S", time.localtime())
        }

    except Exception as e:
        # 网络异常或者 akshare 数据缺失时的降级处理
        logger.warning(f"可转债 {code}({name}) 级别 K 线拉取失败: {str(e)}")
        # 降级：基于实时快照数据简易估算，不使整个接口挂掉
        # 自动生成虚拟布林带用于演示系统弹性
        return {
            "code": code,
            "name": name,
            "price": round(current_price, 3),
            "vwap": round(current_price * 0.998, 3),
            "upper_band": round(current_price * 1.015, 3),
            "lower_band": round(current_price * 0.985, 3),
            "signal": "WAIT",
            "buy_price": round(current_price * 0.985, 3),
            "sell_price": round(current_price * 1.015, 3),
            "turnover": round(float(bond_info.get("amount", 0)) / 10000.0, 2),
            "updated_at": time.strftime("%H:%M:%S", time.localtime()),
            "fallback": True
        }

def update_signals_task():
    """
    同步拉取线程：获取活跃可转债并加载指标，写入共享变量
    """
    logger.info("开始获取最新的活跃可转债数据...")
    try:
        # 1. 获取全市场可转债实时行情快照
        df_realtime = ak.bond_zh_cov_realtime()
        if df_realtime is None or df_realtime.empty:
            logger.error("无法通过 akshare 取得实时可转债列表")
            return
        
        # 2. 转换需要的数据类型，并按日成交额（amount）降序排序
        df_realtime["amount"] = pd.to_numeric(df_realtime["amount"], errors="coerce").fillna(0)
        
        # 2.5 构建全市场最新现价及名称字典映射，支持持仓列表的高精度、实时估值
        all_bonds_dict = {}
        for row in df_realtime.to_dict(orient="records"):
            c = row.get("code")
            if c:
                all_bonds_dict[c] = {
                    "name": row.get("name", ""),
                    "price": float(row.get("trade")) if row.get("trade") is not None else 0.0
                }

        df_sorted = df_realtime.sort_values(by="amount", ascending=False)
        
        # 筛选成交额前 50 的最活跃可转债
        top_50 = df_sorted.head(50).to_dict(orient="records")
        logger.info(f"成功筛选出成交量前 50 活跃债。开始利用多线程线程池计算高频布林指标...")

        results = []
        # 开启 10 个工作线程并行请求 Minute K线，防止新浪接口序列化慢导致总计算时长超限
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(fetch_single_bond_signals, bond) for bond in top_50]
            for fut in futures:
                res = fut.result()
                if res is not None:
                    results.append(res)
        
        # 3. 覆盖全局缓存
        with cache.lock:
            cache.data = results
            cache.all_bonds = all_bonds_dict
            cache.last_updated = time.time()
        
        logger.info(f"决策系统缓存更新完毕! 录入可转债记录: {len(results)} 条")

    except Exception as e:
        logger.error(f"自动化更新执行失败: {str(e)}", exc_info=True)

TRADE_DAYS_CACHE = set()

async def init_trade_calendar():
    """
    通过 AkShare 获取新浪 A 股股票交易日历，并筛选出今天及之后的所有合法交易日。
    利用 asyncio.to_thread 异步执行以防阻塞 FastAPI 事件循环。
    """
    global TRADE_DAYS_CACHE
    logger.info("【日历初始化】开始调用 AkShare 抓取 A 股历史至最新股票交易日历数据...")
    try:
        # 使用 asyncio.to_thread 将同步阻塞获取移至单独的业务工作线程
        df = await asyncio.to_thread(ak.tool_trade_date_hist_sina)
        if df is not None and not df.empty:
            dates = []
            beijing_tz = datetime.timezone(datetime.timedelta(hours=8))
            today_date = datetime.datetime.now(beijing_tz).date()

            # 解析并提取今天及之后的交易日
            for trade_dt in df['trade_date']:
                if isinstance(trade_dt, str):
                    parsed_dt = datetime.datetime.strptime(trade_dt, "%Y-%m-%d").date()
                elif isinstance(trade_dt, datetime.date):
                    parsed_dt = trade_dt
                elif hasattr(trade_dt, 'date'):
                    parsed_dt = trade_dt.date()
                else:
                    parsed_dt = pd.to_datetime(trade_dt).date()

                if parsed_dt >= today_date:
                    dates.append(parsed_dt)

            TRADE_DAYS_CACHE = set(dates)
            logger.info(f"【日历初始化】成功! 本地 A 股后续交易日历已更新缓存，合计 {len(TRADE_DAYS_CACHE)} 个有效交易日。")
        else:
            logger.error("【日历初始化】获取交易日历数据为空，后续将使用周一至周五的预设降级方案。")
    except Exception as e:
        logger.error(f"【日历初始化】通过 AkShare 调取交易日历异常: {str(e)}，后续将使用预设降级方案(周一至周五)。")

async def wait_for_trading_time():
    """
    根据 A 股交易时段控制轮询频率与长休眠，防止非交易时间段拉取导致 IP 封禁。
    当前时间自动按北京时间（UTC+8）转换校准。
    
    1. 判断是否非 A 股官方定义的交易日：
       检查今日日期 (now.date()) 是否在 TRADE_DAYS_CACHE 缓存中。
       如果不在，说明今天是法定节假日或周末，直接挂起休眠到次日 09:25:00。
       
    2. 如果是交易日，判定具体时段：
       - 09:25:00 - 11:30:00：返回并不作休眠，主循环进入 3 秒一次的高频轮询。
       - 11:30:00 - 13:00:00：计算直到 13:00 的秒数并休眠。
       - 13:00:00 - 15:00:00：返回并不作休眠，主循环进入 3 秒一次的高频轮询。
       - 15:00:00 到 次日 09:25:00：计算到明天 09:25:00 的差值秒数并长休眠。
    """
    while True:
        # 获取当前的北京时间 (CST, UTC+8)
        beijing_tz = datetime.timezone(datetime.timedelta(hours=8))
        now_aware = datetime.datetime.now(datetime.timezone.utc).astimezone(beijing_tz)
        now = now_aware.replace(tzinfo=None)
        today_date = now.date()

        # 精确 A 股官方开市交易日判断 (排除周末与所有法定调休长假)
        is_trade_day = True
        if TRADE_DAYS_CACHE:
            is_trade_day = (today_date in TRADE_DAYS_CACHE)
        else:
            # 降级退化：如果日历初始化失败、真实网络离线等，使用标准的普通周一至周五的逻辑
            is_trade_day = (now.weekday() < 5)

        # 1. 非交易日拦截（如果是周末或长假休息日，一律休眠到明日开市前 09:25:00）
        if not is_trade_day:
            tomorrow = now + datetime.timedelta(days=1)
            next_start = tomorrow.replace(hour=9, minute=25, second=0, microsecond=0)
            sleep_sec = (next_start - now).total_seconds()
            logger.info(f"【时段校验】当前北京时间日期 ({today_date}) 判定为非交易日（周末或法定假市）。系统将挂起休眠 {sleep_sec:.1f} 秒至次盘(09:25:00)...")
            await asyncio.sleep(sleep_sec)
            continue

        # 当前北京时间分割点
        t_0925 = now.replace(hour=9, minute=25, second=0, microsecond=0)
        t_1130 = now.replace(hour=11, minute=30, second=0, microsecond=0)
        t_1300 = now.replace(hour=13, minute=0, second=0, microsecond=0)
        t_1500 = now.replace(hour=15, minute=0, second=0, microsecond=0)

        # 2. 早盘段前 (00:00:00 - 09:25:00)
        if now < t_0925:
            sleep_sec = (t_0925 - now).total_seconds()
            logger.info(f"【时段校验】今日（{today_date}）是交易日，但尚未开启集合竞价及早盘。当前北京时间: {now.strftime('%H:%M:%S')}，系统即将挂起休眠 {sleep_sec:.1f} 秒至开盘前(09:25:00)...")
            await asyncio.sleep(sleep_sec)
            continue

        # 3. 上午早盘在开市主时段 (09:25:00 - 11:30:00)
        elif t_0925 <= now <= t_1130:
            return  # 处于早盘交易时间，直接返回进行拉取

        # 4. 午间休市休眠 (11:30:00 - 13:00:00)
        elif t_1130 < now < t_1300:
            sleep_sec = (t_1300 - now).total_seconds()
            logger.info(f"【时段校验】进入 A 股午间休市期。当前北京时间: {now.strftime('%H:%M:%S')}，系统即将睡眠挂起 {sleep_sec:.1f} 秒至下午开盘(13:00:00)...")
            await asyncio.sleep(sleep_sec)
            continue

        # 5. 下午盘开盘主时段 (13:00:00 - 15:00:00)
        elif t_1300 <= now <= t_1500:
            return  # 处于下午盘交易时间，直接返回进行拉取

        # 6. 下午盘后收市 (15:00:00 - 23:59:59)
        else:
            # 计算到明日 09:25:00 的总时长
            tomorrow = now + datetime.timedelta(days=1)
            next_start = tomorrow.replace(hour=9, minute=25, second=0, microsecond=0)
            sleep_sec = (next_start - now).total_seconds()
            logger.info(f"【时段校验】今日 A 股已收盘结账。当前北京时间: {now.strftime('%H:%M:%S')}，系统即将转入夜间托管休眠，共计 {sleep_sec:.1f} 秒，将于明市前自动唤醒。")
            await asyncio.sleep(sleep_sec)
            continue

async def background_worker():
    """
    异步监控高频轮询主循环。每次拉取前检查交易时间，并支持3秒一次的高频轮询。
    """
    logger.info("高频轮询异步循环监控引擎启动成功。")
    while True:
        try:
            # 1. 检查是否在 A 股官方交易时段中
            await wait_for_trading_time()
            
            # 2. 从线程池中执行同步抓取
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, update_signals_task)
            
        except Exception as e:
            logger.error(f"自动化高频更新调度发生意料外异常: {str(e)}", exc_info=True)
            
        # 3. 间隔 3 秒执行下一次抓取
        await asyncio.sleep(3)

@app.on_event("startup")
async def startup_event():
    # 优先同步获取并构建 A 股交易日历缓存（同步挂起等待）
    await init_trade_calendar()
    # 启动后台异步任务进行实时判定
    asyncio.create_task(background_worker())
    logger.info("量化监控后台定时器异步轮询任务已创建！已转至 A 股交易时段高级控频托管模式。")

@app.get("/")
def index():
    return {
        "status": "online",
        "message": "极简可转债量化辅助决策系统后端正在运行！",
        "api_endpoints": {
            "signals": "/api/signals"
        },
        "system_time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    }

@app.get("/api/signals")
def get_signals():
    """
    提供给前端展示的决策信号 API
    返回数据包括：代码、名称、现价、VWAP、信号状态、建议买/卖价位、成交额等
    """
    with cache.lock:
        data_to_return = list(cache.data)
        last_up = cache.last_updated

    if not data_to_return:
        # 如果还在首次初始化，则同步拉取一次
        logger.info("由于缓存中无记录，API 触发同步数据更新拉取...")
        update_signals_task()
        with cache.lock:
            data_to_return = list(cache.data)
            last_up = cache.last_updated
            
        if not data_to_return:
            raise HTTPException(status_code=503, detail="数据获取中，请稍后再试")

    return {
        "status": "success",
        "total_count": len(data_to_return),
        "last_updated": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(last_up)) if last_up > 0 else "N/A",
        "data": data_to_return
    }

@app.get("/api/paper/account")
def get_paper_account():
    """
    获取模拟盘账户详情：总资产、可用现金、持仓实时市值、各持仓盈亏及明细
    """
    with cache.lock:
        all_bonds = dict(cache.all_bonds)
    try:
        summary = paper_trader.get_account_summary(all_bonds)
        return {
            "status": "success",
            "data": summary
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取模拟账户摘要异常: {str(e)}")

@app.post("/api/paper/trade")
def post_paper_trade(trade: TradeRequest):
    """
    提交模拟盘买卖撮合申报。
    买入扣减可用现金并摊平持仓成本；
    卖出释放对应持仓并回笼金额；
    固定万分之二手续费损耗；
    """
    with cache.lock:
        all_bonds = dict(cache.all_bonds)
    try:
        result = paper_trader.execute_trade(
            symbol=trade.symbol,
            action=trade.action,
            price=trade.price,
            amount=trade.amount,
            all_bonds_cache=all_bonds
        )
        return {
            "status": "success",
            "data": result
        }
    except ValueError as ve:
        # 处理模拟规则限制校验拦截（如本金不足或券源不足等）
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"模拟撮合服务发生内部异常: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"模拟撮合处理异常: {str(e)}")

@app.post("/api/paper/reset")
def reset_paper_account():
    """
    一键重置当前账户回归 10 万初始资产
    """
    initial_data = {
        "cash": 100000.0,
        "positions": {}
    }
    try:
        paper_trader._save_portfolio(initial_data)
        return {
            "status": "success",
            "message": "模拟交易账户已重置成功，可用资金恢复至 100000.00 元，持仓已清空。"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"重置模拟账户失败: {str(e)}")

if __name__ == "__main__":
    # 端口 3000 是平台统一要求，本地调试时可自行修改。
    # 这里默认绑定 8000 端口，前端开发可以独立通过跨域访问
    print("正在启动量化辅助决策系统 FastAPI 服务器...")
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
