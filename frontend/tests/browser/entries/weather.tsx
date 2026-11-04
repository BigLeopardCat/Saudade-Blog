import {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {getCurrentWeather, installWeatherContext, warmWeather} from '../../../src/components/Live2dAgent/weather';

function Weather() {
  const [snapshot, setSnapshot] = useState('');
  useEffect(() => {
    const cleanup = installWeatherContext();
    void warmWeather().then(() => setSnapshot(JSON.stringify(getCurrentWeather())));
    return cleanup;
  }, []);
  return <><output aria-label="城市天气">{snapshot}</output><button onClick={() =>
    setSnapshot(JSON.stringify(window.__agentCurrentWeather?.()))}>读取快照</button></>;
}
createRoot(document.getElementById('root')!).render(<Weather/>);
