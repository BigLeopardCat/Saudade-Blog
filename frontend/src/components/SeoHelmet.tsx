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

// 站点身份（canonical / og:url 的绝对前缀、站名、默认描述）。**别人部署必须能改** ——
// 这几处与 `index.html` 的占位符是同一批值，都读 `VITE_SITE_*`（默认值写在
// `vite.config.ts` 里，不读 `.env`：本仓 `.env*` 整类被 gitignore，别人 clone 后没有
// 任何 .env，占位符会原样留在产物里）。改自己的域名/站名/描述只需设对应变量。
import { SITE_URL, SITE_TITLE, SITE_DESCRIPTION } from '../utils/siteUrl';

const SITE = SITE_URL;

const SeoHelmet: React.FC<SeoHelmetProps> = ({
  title,
  description = SITE_DESCRIPTION,
  image = '/logo.png',
  url = '/',
  type = 'website',
  suffix = true,
}) => {
  // 20260905：分隔符弃 em dash（用户：标题不想要破折号），改竖线；首页不拼后缀
  const fullTitle = suffix === false ? title : `${title} | ${SITE_TITLE}`;
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