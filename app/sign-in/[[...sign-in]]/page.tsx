import { SignIn } from "@clerk/nextjs";
import { AuthFrame } from "../../_components/auth-frame";

export default function Page() {
  return (
    <AuthFrame>
      <SignIn />
    </AuthFrame>
  );
}
