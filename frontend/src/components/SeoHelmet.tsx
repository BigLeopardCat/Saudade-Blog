import { Helmet } from 'react-helmet-async';
import { useLocation } from 'react-router-dom';
import { SITE_URL, SITE_TITLE, SITE_DESCRIPTION } from '../utils/siteUrl';

interface SeoHelmetProps {
  title: string;
  description?: string;
  image?: string;
  url?: string;
  type?: string;
  /** 是否拼接站点名后缀（默认拼；首页 title 即品牌名时传 false 不拼） */
  suffix?: boolean;
  noindex?: boolean;
}

const SeoHelmet: React.FC<SeoHelmetProps> = ({
  title,
  description = SITE_DESCRIPTION,
  image = '/logo.png',
  url,
  type = 'website',
  suffix = true,
  noindex = false,
}) => {
  const { pathname } = useLocation();
  const fullTitle = suffix === false ? title : `${title} | ${SITE_TITLE}`;
  const fullUrl = new URL(url ?? pathname, SITE_URL + '/');
  fullUrl.hash = '';
  let fullImage = new URL('/logo.png', SITE_URL + '/').href;
  try {
    const candidate = new URL(image, SITE_URL + '/');
    if (['http:', 'https:'].includes(candidate.protocol)) fullImage = candidate.href;
  } catch { /* Invalid stored cover URLs use the site's fallback image. */ }

  return (
    <Helmet defer={false}>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <meta name="robots" content={noindex ? 'noindex, follow' : 'index, follow'} />
      {!noindex && <link rel="canonical" href={fullUrl.href} />}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={fullUrl.href} />
      <meta property="og:type" content={type} />
      <meta property="og:image" content={fullImage} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={fullImage} />
    </Helmet>
  );
};

export default SeoHelmet;
