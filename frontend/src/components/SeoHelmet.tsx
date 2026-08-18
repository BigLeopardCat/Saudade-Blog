import { Helmet } from 'react-helmet-async';

interface SeoHelmetProps {
  title: string;
  description?: string;
  image?: string;
  url?: string;
  type?: string;
}

const SITE = 'https://saudade.site';

const SeoHelmet: React.FC<SeoHelmetProps> = ({
  title,
  description = '个人技术博客 — Rust、React、IoT 开发',
  image = '/logo.png',
  url = '/',
  type = 'website',
}) => {
  const fullTitle = `${title} — Saudade Blog`;
  const fullUrl = `${SITE}${url}`;
  const fullImage = image.startsWith('http') ? image : `${SITE}${image}`;

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={fullUrl} />
      {/* Open Graph */}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:type" content={type} />
      <meta property="og:image" content={fullImage} />
      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
    </Helmet>
  );
};

export default SeoHelmet;