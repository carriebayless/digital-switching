export default function handler(req, res) {
  res.setHeader("Set-Cookie", `magic=deleted; HttpOnly; Path=/; Max-Age=0; Secure; SameSite=Lax`);
  res.status(200).json({ ok: true });
}
