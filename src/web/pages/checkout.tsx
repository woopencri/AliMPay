import { CheckCircle2, Clock3, ExternalLink, ShieldCheck, TriangleAlert } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import useSWR from "swr";
import { PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS, type CheckoutData } from "@/shared/contracts";
import { swrFetcher } from "@/web/api";
import { AlipayIcon } from "@/web/components/alipay-icon";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent } from "@/web/components/ui/card";
import { Loading } from "@/web/components/ui/loading";
import { formatDate } from "@/web/lib/utils";

function countdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

// Keep this callback stable: countdown renders must not restart SWR's polling timer.
function checkoutRefreshInterval(latest: CheckoutData | undefined) {
  if (latest && (["paid", "late_paid"].includes(latest.status) || Date.parse(latest.monitor_until) <= Date.now())) return 0;
  return (latest?.payment_poll_interval_seconds ?? PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS) * 1_000;
}

function isMobileBrowser() {
  const browserNavigator = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (browserNavigator.userAgentData?.mobile === true) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(browserNavigator.userAgent) ||
    (/Macintosh/i.test(browserNavigator.userAgent) && browserNavigator.maxTouchPoints > 1);
}

function CheckoutSupport({ message }: { message: string }) {
  if (!message) return null;
  return <p className="mt-4 whitespace-pre-wrap break-words rounded-md border bg-foreground/[0.025] p-3 text-left text-sm leading-6 text-muted">{message}</p>;
}

export function CheckoutPage() {
  const { token = "" } = useParams();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "支付宝安全收银台";
    return () => { document.title = previousTitle; };
  }, []);
  const mobileRedirectAttempted = useRef(false);
  const { data, error, isLoading } = useSWR<CheckoutData>(`/public-api/checkout/${encodeURIComponent(token)}`, swrFetcher, {
    refreshInterval: checkoutRefreshInterval,
    shouldRetryOnError: false,
  });
  const { data: generatedQr } = useSWR(
    data?.collection_mode === "transfer" && data.payment_uri ? ["transfer-qr", data.payment_uri] : null,
    ([, uri]) => QRCode.toDataURL(uri, { width: 300, margin: 2, errorCorrectionLevel: "M", color: { dark: "#0f172a", light: "#f8fafc" } }),
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (
      mobileRedirectAttempted.current ||
      !data ||
      data.collection_mode !== "transfer" ||
      data.status !== "pending" ||
      !data.payment_uri ||
      Date.parse(data.expires_at) <= Date.now() ||
      !isMobileBrowser()
    ) return;

    mobileRedirectAttempted.current = true;
    window.location.assign(data.payment_uri);
  }, [data]);

  if (isLoading) return <Loading label="正在读取支付订单" />;
  if (error || !data) return <main className="flex min-h-screen items-center justify-center px-4"><div className="max-w-sm text-center"><TriangleAlert className="mx-auto size-9 text-destructive" /><h1 className="mt-4 text-xl font-semibold">订单不存在</h1><p className="mt-2 text-sm text-muted">链接可能无效，或订单信息无法读取。</p></div></main>;

  const paid = data.status === "paid" || data.status === "late_paid";
  const checkoutExpired = now >= Date.parse(data.expires_at);
  const monitoringEnded = now >= Date.parse(data.monitor_until);

  if (paid) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12">
        <Card className="w-full max-w-md">
          <CardContent className="px-6 py-10 text-center">
            <CheckCircle2 className="mx-auto size-12 text-success" />
            <Badge className="mt-5" variant="success">支付成功</Badge>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">已收到 ¥{data.payable_money}</h1>
            <p className="mt-2 break-all text-sm text-muted">订单 {data.out_trade_no} 已完成。</p>
            {data.return_target ? <Button className="mt-6 w-full" asChild><a href={data.return_target}>返回商家<ExternalLink /></a></Button> : null}
            <CheckoutSupport message={data.checkout_support_message} />
          </CardContent>
        </Card>
      </main>
    );
  }

  if (monitoringEnded) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12"><Card className="w-full max-w-md"><CardContent className="px-6 py-10 text-center"><Clock3 className="mx-auto size-10 text-destructive" /><h1 className="mt-4 text-xl font-semibold">订单已超时</h1><p className="mt-2 text-sm leading-6 text-muted">请勿继续付款，请返回商家重新下单。如已付款，请联系商家查询。</p><div className="mt-6 rounded-md border p-3 text-left text-xs text-muted">订单号：<span className="font-mono text-foreground">{data.out_trade_no}</span></div><CheckoutSupport message={data.checkout_support_message} /></CardContent></Card></main>
    );
  }

  return (
    <main className="min-h-screen px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-center gap-2 text-sm font-semibold"><AlipayIcon className="size-5 text-[#1677ff]" />支付宝安全收银台</header>
        <div className="grid gap-6 md:grid-cols-[1fr_320px]">
          <Card>
            <CardContent className="px-5 py-6 sm:px-7">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-muted">{data.name}</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">¥{data.payable_money}</h1></div><Badge variant={checkoutExpired ? "danger" : "primary"}>{checkoutExpired ? "已超时，等待付款确认" : `剩余 ${countdown(Date.parse(data.expires_at) - now)}`}</Badge></div>
              {data.payable_money !== data.requested_money ? (
                <div role="alert" className="mt-4 rounded-md border-2 border-destructive/50 bg-destructive/5 p-4 text-sm leading-6">
                  <p className="flex items-start gap-2 font-semibold text-destructive"><TriangleAlert className="mt-0.5 size-5 shrink-0" />请务必按精确金额 ¥{data.payable_money} 付款</p>
                  <p className="mt-2">订单原金额为 ¥{data.requested_money}。请勿少付、多付或取整，以免影响付款确认。</p>
                </div>
              ) : null}
              <CheckoutSupport message={data.checkout_support_message} />

              <div className="mt-6 flex min-h-[300px] items-center justify-center rounded-lg border p-5">
                {data.collection_mode === "business_qr" ? <img src={data.business_qr_url} alt="支付宝经营码" className="max-h-[270px] max-w-full object-contain" /> : generatedQr ? <img src={generatedQr} alt="支付宝转账二维码" className="size-[270px] max-w-full object-contain" /> : <Loading label="正在生成二维码" />}
              </div>
              {data.collection_mode === "transfer" && data.payment_uri ? <Button className="mt-4 w-full md:hidden" asChild><a href={data.payment_uri}>打开支付宝<ExternalLink /></a></Button> : null}
              <div className="mt-5 flex items-start gap-3 text-sm leading-6 text-muted"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" /><p>{data.collection_mode === "business_qr" ? "打开支付宝扫一扫，并输入上方显示的金额。" : `打开支付宝扫码付款，请保留付款备注 ${data.out_trade_no}，不要修改。`}</p></div>
              {checkoutExpired ? <div className="mt-4 flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-muted"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />付款时间已过，请勿继续付款。如果已经付款，请稍候，页面会自动更新；尚未付款请返回商家重新下单。</div> : null}
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card><CardContent className="px-5 py-5"><h2 className="text-sm font-semibold">订单信息</h2><dl className="mt-4 space-y-4"><div><dt className="text-xs text-muted">订单号</dt><dd className="mt-1 break-all font-mono text-xs">{data.out_trade_no}</dd></div><div><dt className="text-xs text-muted">交易号</dt><dd className="mt-1 break-all font-mono text-xs">{data.trade_no}</dd></div><div><dt className="text-xs text-muted">创建时间</dt><dd className="mt-1 text-sm">{formatDate(data.created_at)}</dd></div></dl></CardContent></Card>
            <Card><CardContent className="px-5 py-5 text-xs leading-5 text-muted"><p>付款后页面会自动更新，请勿重复付款。</p></CardContent></Card>
          </div>
        </div>
      </div>
    </main>
  );
}
