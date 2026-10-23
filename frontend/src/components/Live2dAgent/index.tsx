import {useEffect} from 'react';
import '../../utils/chatMarkdown';
import {loadAgent} from './loader';

const Live2dAgent: React.FC = () => {
  useEffect(() => {
    void loadAgent().catch(error => console.error('[Live2dAgent]', error));
  }, []);
  return null;
};
Live2dAgent.displayName = 'Live2dAgent';
export default Live2dAgent;
