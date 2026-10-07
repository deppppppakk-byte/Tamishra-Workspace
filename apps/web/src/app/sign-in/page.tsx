import { Suspense } from "react";
import { AuthForm } from "../../components/auth/auth-form";

function SignInFallback() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <p>Loading sign in…</p>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<SignInFallback />}>
      <AuthForm />
    </Suspense>
  );
}
