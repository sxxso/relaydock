import { handleApi } from "@/lib/api";
import { getStore } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handler(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    return await handleApi(request, (await context.params).path, getStore());
  } catch {
    return Response.json(
      { error: "本机数据库或主密钥配置错误，请检查部署目录" },
      { status: 503 },
    );
  }
}
export {
  handler as GET,
  handler as POST,
  handler as PATCH,
  handler as DELETE,
  handler as PUT,
};

