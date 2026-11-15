import app, { type Env } from './index';

// Pages Advanced Mode serves the existing API and Studio routes on one origin.
export default {
  fetch(request: Request, env: Env, context: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/') || pathname === '/studio' || pathname.startsWith('/studio/') || pathname.startsWith('/t/') || pathname.startsWith('/p/')) {
      return app.fetch(request, env, context);
    }
    return env.ASSETS.fetch(request);
  }
};
