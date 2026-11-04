import {useEffect,useState} from 'react'
import {Alert,Button,Card,Input,InputNumber,Modal,Select,Space,Spin,Typography,message} from 'antd'
import {useDispatch} from 'react-redux'
import type {AppDispatch} from '../../../store'
import {imageGenerationApi as api,type GenerationJob} from '../../../apis/imageGenerationApi'
import {galleryApi,galleryError} from '../../../apis/galleryApi'
import {resolveApiAssetUrl} from '../../../utils/runtimeApi'
import {assetDisplayName} from '../../../utils/assetName'

const statusNames:Record<string,string>={pending:'等待确认提示词',generating:'正在生成',review:'等待审阅图片',accepted:'已存入图库',rejected:'已放弃',failed:'生成失败',unknown:'结果待核实',expired:'审批已过期'}
export default function ImageGeneration({onClose}:{onClose:()=>void}){
  const dispatch=useDispatch<AppDispatch>()
  const options=api.useGenerationOptionsQuery()
  const jobs=api.useGenerationJobsQuery(undefined,{pollingInterval:15000})
  const [active,setActive]=useState<Pick<GenerationJob,'id'|'status'>|null>(null)
  const current=api.useGenerationJobQuery(active?.id??'',{skip:!active,pollingInterval:active?.status==='generating'?3000:0})
  const job=current.data?.id===active?.id?current.data:null
  useEffect(()=>{if(job&&active?.status!==job.status)setActive({id:job.id,status:job.status})},[job,active?.status])
  const images=galleryApi.useImagesInfiniteQuery({})
  const [prompt,setPrompt]=useState('')
  const [model,setModel]=useState<string>()
  const [size,setSize]=useState('1536x1024')
  const [quality,setQuality]=useState('high')
  const [referenceIds,setReferences]=useState<number[]>([])
  const [articleId,setArticleId]=useState<number|null>(null)
  const [loadingArticle,setLoadingArticle]=useState(false)
  const [create,{isLoading:creating}]=api.useCreateGenerationMutation()
  const [approve,{isLoading:approving}]=api.useApproveGenerationMutation()
  const [accept,{isLoading:accepting}]=api.useAcceptGenerationMutation()
  const [reject,{isLoading:rejecting}]=api.useRejectGenerationMutation()
  const busy=creating||approving||accepting||rejecting
  const fail=(e:unknown)=>void message.error(galleryError(e))
  const updated=async(action:Promise<GenerationJob>)=>{
    try{const value=await action;setActive(value);await current.refetch();void jobs.refetch()}
    catch(e){fail(e)}
  }
  const prepare=async()=>{
    try{
      const value=await create({prompt,model:model||options.data?.defaultModel||'',size,quality,referenceIds}).unwrap()
      setActive(value);void jobs.refetch()
    }catch(e){fail(e)}
  }
  const fromArticle=async()=>{
    if(!articleId)return
    setLoadingArticle(true)
    try {
      const article=await dispatch(api.endpoints.generationArticle.initiate(articleId,{subscribe:false,forceRefetch:true})).unwrap()
      setPrompt(`为以下博客文章绘制一张封面。构图清晰、主体完整，适合横向文章卡片。不要添加未经要求的文字。\n\n标题：${article.title}\n摘要：${article.description}\n\n文章内容（最多 12000 字，作为画面选题参考）：\n${article.content}`)
      setActive(null)
    }catch(e){fail(e)}finally{setLoadingArticle(false)}
  }
  const rows=images.data?.pages.flatMap(p=>p.items)??[]
  return <Modal title="AI 生图" open width={1040} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    <div className="generationLayout">
      <aside className="generationHistory"><Space direction="vertical" style={{width:'100%'}}>
        <Button block onClick={()=>setActive(null)}>新建图片</Button>
        {jobs.isError&&<Alert type="error" message="任务列表加载失败" action={<Button onClick={()=>void jobs.refetch()}>重试</Button>}/>}
        {jobs.data?.map(item=><Button key={item.id} block type={job?.id===item.id?'primary':'default'} onClick={()=>setActive(item)}>
          {statusNames[item.status]||item.status} · {item.title.slice(0,14)}
        </Button>)}
      </Space></aside>
      <main className="generationMain">
        {!options.data?.configured&&<Alert type="info" showIcon message="请先在服务器配置生图 API 密钥和可用模型列表"/>}
        {options.isError&&<Alert type="error" message="生图配置读取失败"/>}
        {!active?<Space direction="vertical" style={{width:'100%'}} size="middle">
          <Typography.Paragraph>先编辑提示词和参考图，下一步会完整展示请求供你确认；确认前不会调用生图 API。</Typography.Paragraph>
          <Space wrap><InputNumber aria-label="参考文章编号" min={1} value={articleId} onChange={setArticleId} placeholder="文章编号"/>
            <Button disabled={!articleId} loading={loadingArticle} onClick={()=>void fromArticle()}>根据文章填写提示词</Button></Space>
          <label htmlFor="generation-prompt">提示词</label>
          <Input.TextArea id="generation-prompt" value={prompt} maxLength={32000} showCount autoSize={{minRows:7,maxRows:16}} onChange={e=>setPrompt(e.target.value)}/>
          <Space wrap>
            <Select aria-label="生图模型" style={{minWidth:240}} value={model||options.data?.defaultModel} options={options.data?.models.map(value=>({value,label:value}))} onChange={setModel}/>
            <Select aria-label="图片尺寸" value={size} onChange={setSize} options={['1536x1024','1024x1024','1024x1536'].map(value=>({value,label:value}))}/>
            <Select aria-label="图片质量" value={quality} onChange={setQuality} options={[{value:'high',label:'高质量'},{value:'medium',label:'标准质量'},{value:'low',label:'低质量'},{value:'auto',label:'自动质量'}]}/>
          </Space>
          <label>参考图（选填，最多 4 张；只使用你选中的图片）</label>
          <Select aria-label="生图参考图" mode="multiple" maxCount={4} style={{width:'100%'}} placeholder="不使用参考图" value={referenceIds} onChange={setReferences}
            options={rows.map(row=>({value:row.imageKey,label:row.displayName||assetDisplayName(row.imageUrl)}))}/>
          {images.hasNextPage&&<Button loading={images.isFetchingNextPage} onClick={()=>void images.fetchNextPage()}>加载更多图库图片</Button>}
          <Button type="primary" loading={creating} disabled={!options.data?.configured||!prompt.trim()||loadingArticle} onClick={()=>void prepare()}>预览请求</Button>
        </Space>:job?<Space direction="vertical" style={{width:'100%'}} size="middle">
          <Typography.Title level={5}>{statusNames[job.status]||job.status}</Typography.Title>
          <Card size="small" title="本次请求">
            <Typography.Paragraph>{job.request.provider}</Typography.Paragraph>
            <Typography.Paragraph>{job.request.model} · {job.request.size} · {job.request.quality} · 1 张</Typography.Paragraph>
            <pre className="generationPrompt">{job.request.prompt}</pre>
            <Typography.Paragraph>{job.request.references.length?'参考图（批准时将发送这些固定快照）':'未使用参考图'}</Typography.Paragraph>
            <div className="generationReferences">{job.request.references.map(ref=><figure key={ref.imageId}>
              {ref.previewUrl&&<img src={resolveApiAssetUrl(ref.previewUrl)} alt={ref.name}/>}
              <figcaption>{ref.name}</figcaption>
            </figure>)}</div>
          </Card>
          {job.status==='pending'&&<Space wrap><Button type="primary" disabled={busy} loading={approving} onClick={()=>void updated(approve({id:job.id,version:job.requestHash}).unwrap())}>确认提示词与参考图，开始生成</Button>
            <Button disabled={busy} onClick={()=>{setPrompt(job.request.prompt);setModel(job.request.model);setSize(job.request.size);setQuality(job.request.quality);setReferences(job.request.references.map(r=>r.imageId));setActive(null)}}>返回修改</Button></Space>}
          {job.status==='generating'&&<Alert type="info" icon={<Spin size="small"/>} showIcon message="正在生成图片，可以关闭窗口，稍后回来审阅。请勿重复创建相同任务。"/>}
          {job.previewUrl&&<img className="generationResult" src={resolveApiAssetUrl(job.previewUrl)} alt="本次生成结果"/>}
          {job.status==='review'&&<><Alert type="info" message="请查看实际生成结果。确认入库后才会出现在图库中；不会自动修改文章封面。"/>
            <Button type="primary" loading={accepting} disabled={busy||!job.outputHash} onClick={()=>void updated(accept({id:job.id,version:job.outputHash!}).unwrap())}>确认结果并存入图库</Button></>}
          {['pending','review'].includes(job.status)&&<Button danger disabled={busy} loading={rejecting} onClick={()=>void updated(reject(job.id).unwrap())}>放弃本次{job.status==='pending'?'请求':'结果'}</Button>}
          {job.error&&<Alert type="warning" message={job.error}/>}
          {job.status==='unknown'&&<Alert type="warning" message="请求结果尚未核实，不会自动重试扣费。请检查服务商调用记录。"/>}
          {job.status==='accepted'&&<Alert type="success" message={`已存入图库，图片编号 ${job.imageId}。可在文章编辑页选择封面，或请助手设置。`}/>}
        </Space>:<Spin/>}
      </main>
    </div>
  </Modal>
}
