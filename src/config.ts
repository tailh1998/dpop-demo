const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

export const config = {
  apiBaseUrl: trimTrailingSlash(
    import.meta.env.VITE_API_BASE_URL || 'https://api.example.invalid'
  ),
  loginPath: import.meta.env.VITE_LOGIN_PATH || '/auth/dpop/sign-in',
  refreshPath: import.meta.env.VITE_REFRESH_PATH || '/auth/dpop/refresh',
  profilePath: import.meta.env.VITE_PROFILE_PATH || '/api/me'
};

export const toApiUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) return path;
  return `${config.apiBaseUrl}/${path.replace(/^\/+/, '')}`;
};
