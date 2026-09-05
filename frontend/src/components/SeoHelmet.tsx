import { Helmet } from 'react-helmet-async';

interface SeoHelmetProps {
  title: string;
  description?: string;
  image?: string;
  url?: string;
  type?: string;
  /** 是否拼接站点名后缀（默认拼；首页 title 即品牌名时传 false 不拼） */
  suffix?: boolean;
}

const SITE = 'https://saudade.site';

const SeoHelmet: React.FC<SeoHelmetProps> = ({
  title,
  description = '个人技术博客 · Rust、React、IoT 开发',
  image = '/logo.png',
  url = '/',
  type = 'website',
  suffix = true,
}) => {
  // 20260905：分隔符弃 em dash（用户：标题不想要破折号），改竖线；首页不拼后缀
  const fullTitle = suffix === false ? title : `${title} | Saudade Blog`;
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