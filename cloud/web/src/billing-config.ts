export const paddleClientToken = import.meta.env.VITE_PADDLE_CLIENT_TOKEN ?? "";
export const paddleEnvironment = (import.meta.env.VITE_PADDLE_ENVIRONMENT ?? "sandbox") as "sandbox" | "production";
