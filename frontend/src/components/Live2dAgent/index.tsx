import {useEffect} from 'react';
import '../../utils/chatMarkdown';
import '../../frontHome/Content/ReadArticle/zoomOverlay';
import {loadAgent} from './loader';
import {installWeatherContext, warmWeather} from './weather';

const Live2dAgent: React.FC = () => {
  useEffect(() => {
    const cleanup = installWeatherContext();
    void loadAgent().then(() => warmWeather()).catch(error => console.error('[Live2dAgent]', error));
    return cleanup;
  }, []);
  return null;
};
Live2dAgent.displayName = 'Live2dAgent';
export default Live2dAgent;
