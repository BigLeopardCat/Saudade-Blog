/** Repository documentation references are checked offline, including image assets. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs'
import path from 'node:path'
import {unified} from 'unified'
import remarkParse from 'remark-parse'
import {fileURLToPath} from 'node:url'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const links=text=>{
  const root=unified().use(remarkParse).parse(text)
  const result=[],definitions=new Map()
  const visit=(node,handle)=>{handle(node);for(const child of node.children||[])visit(child,handle)}
  visit(root,node=>{if(node.type==='definition') definitions.set(node.identifier,node.url)})
  visit(root,node=>{
    const url=node.type==='link'||node.type==='image'?node.url
      :node.type==='linkReference'||node.type==='imageReference'?definitions.get(node.identifier):undefined
    if(url)result.push(url)
  })
  return result
}
const broken=(base,files)=>files.flatMap(file=>links(readFileSync(file,'utf8')).flatMap(link=>{
  if (/^(?:[a-z]+:|\/|#)/i.test(link)) return []
  const name=decodeURIComponent(link.split('#')[0])
  const target=path.resolve(path.dirname(file),name)
  return target.startsWith(base+path.sep)&&!existsSync(target)?[`${path.relative(base,file)}: ${link}`]:[]
}))
test('maintained pages and screenshots have no broken local references',()=>{
  const files=[...readdirSync(root).filter(file=>file.endsWith('.md')).map(file=>path.join(root,file)),
    ...readdirSync(path.join(root,'docs')).filter(file=>file.endsWith('.md')).map(file=>path.join(root,'docs',file)),
    path.join(root,'deploy/README.md'),path.join(root,'frontend/README.md')]
  assert.deepEqual(broken(root,files),[])
  const index=links(readFileSync(path.join(root,'docs/README.md'),'utf8')).map(link=>link.split('#')[0])
  for (const file of readdirSync(path.join(root,'docs')).filter(file=>file.endsWith('.md')&&file!=='README.md'))
    assert.ok(index.includes(file),`Missing document in index: ${file}`)
  for (const file of files) assert.ok(statSync(file).isFile())
})
