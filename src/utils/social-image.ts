const socialImageVersion = Date.now().toString(36);

export function getSocialImageUrl(src: string, baseUrl: URL | string) {
	const url = new URL(src, baseUrl);
	url.searchParams.set('v', socialImageVersion);

	return url;
}
