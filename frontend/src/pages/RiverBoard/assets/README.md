# 场景美术资源

使用内置 image_gen 生成，未使用 CLI/API fallback。原始生成文件保留在工具输出目录；应用引用的最终文件已保存到本目录。WebP 只做格式编码与体积优化，没有程序生成替代美术内容。

- `night-river.webp`：1672×941，东方夜河环境静态美术层，约 164 KiB。
- `lanterns.webp`：2172×724，真透明三格 atlas，约 274 KiB；左为莲花河灯，中为六角宫灯，右为素纱圆灯。CSS 按三个等宽单元取景，所有实例共用一次图像解码。

## 环境最终提示词

Use case: stylized-concept. Asset type: production background matte painting for a cinematic river lantern guestbook web page, not a UI mockup. Create a wide 16:9 landscape at the highest available landscape resolution. AAA game environment key art, photorealistic physically grounded, film still. Camera low on the shore of an immense tranquil river at blue hour turning into night, looking across very dark deep teal water into a misty ancient Chinese mountain valley. Upper 42 percent of image: layered atmospheric jagged karst mountains receding in blue silver haze, a tiny distant pavilion and warm windows on the far RIGHT bank, silver clouds, delicate starlight. A small soft crescent moon near x=70%, y=15%, not a large planet. River shoreline and horizon near y=42%. Lower 58 percent: spacious open dark river with highly subtle realistic ripples, faint moonlit reflection toward right-center, good negative space for interactive lanterns composited later. Near lower left and far right edges very subtle realistic wet rocks and reeds framing the view, without obstructing the center. Mood contemplative, elegant, dreamlike but realistic, premium Unreal Engine environment art with controlled filmic highlights, rich ink blue shadows and faint jade reflections, selective warm amber architectural lights. The LEFT upper quadrant must be dark uncluttered negative space for editorial white Chinese title text overlaid by code. No lanterns anywhere in this image, no floating candles, no people, no boats, no text, no logo, no border, no watermark. Fine environmental texture, strong depth through atmospheric perspective, not a flat vector illustration, not cartoon, not oversaturated, not a giant moon. Keep contrast legible and the water dark, avoid crushed black.

实际生成图的水岸约在中线；渲染器按选中的实际美术资源取 WATER_TOP=0.52，而非把提示词的地平线数值当实测结果。

## 灯具最终编辑提示词

参考上一版三灯横排图进行重新设计，工具指定 transparent_background=true：

重新设计这张三灯横排素材，保留三个独立对象的横向排列和真正透明背景，但完全重做造型、比例与材质，使其符合中国传统工艺美术的清雅审美。用于东方夜河场景中的漂浮河灯，最终会以约60到100像素宽呈现，所以轮廓应优美清晰、细节节制。美术方向：宋画的清雅设色、传统花灯的轻盈比例、工笔画般克制细致的造型，再以高级游戏美术的精致立体体积呈现。配色月白、浅玉、淡金，极少量朱砂点缀；柔和小烛光从内透出，亮而不刺眼。左侧：清雅的莲花河灯，三层自然弯曲的半透明莲瓣，外瓣略带极淡胭脂粉，内瓣月白暖金，有细薄莲叶状底托，花瓣像真正盛开的睡莲而不是直立火焰、折纸尖刺或五角星。中间：雅致六角宫灯，纤细的深红漆木骨架，修长但不高耸的比例，微翘的六角檐口，淡金包角，六面半透明月白绢纱，极简淡墨兰草纹样，配很短的朱砂结绳点缀，放在低矮轻薄六角浮托上，不能有沉重黑色底座、粗糙木桶、金属铜铆钉、教堂彩色玻璃或西式提灯形态。右侧：传统中国素纱圆灯，秀美的椭圆轮廓，细密匀整竹篾骨架，月白薄纱，顶底各一圈极细朱红漆口，温柔淡金灯心，低矮暗色浮托，不能像粗竹筐或桶。三盏灯都没有把手，不要长垂穗（这是河上漂浮的灯），不要文字、汉字、符号、Logo，不要刻意仿古做旧、脏污和夸张纸纹。统一略俯视的三分之四侧视角，与水上漂浮的河灯一致，三件尺度协调，干净轮廓，周围留足透明边距，没有地面、没有水、没有倒影、没有投影、没有环境。不要卡通、不要矢量图标、不要廉价塑料质感。输出宽幅3:1真透明PNG素材，三盏灯各自完整容纳在左中右三个等宽正方格内，不能相互接触。
