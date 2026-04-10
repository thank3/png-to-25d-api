let jsVersion = Date.now();
if(location.protocol == "https:")jsVersion = (Date.now() + "").substring(0, 5) * 1;
let minFile = location.protocol == "https:" ? ".min" : "";
document.write(`
	<script defer language=javascript src='https://statics.3dpea.com/js/Zdsdadcksdfsjlfhe.js?v=${jsVersion}'></script>
    <script defer language=javascript src='https://statics.3dpea.com/js4/OFWuEs6dalicDR2dY7Fr3w==r155.js'></script>
    <!-- <script language=javascript src='https://statics.3dpea.com/jslib-VPE/OFWuEs6dalicDR2dY7Fr3w==r155.js'></script> -->
    <script defer language=javascript src='https://statics.3dpea.com/js/wdjsfhdhgssGJDHSs.js'></script>
    <script defer src="https://statics.3dpea.com/js4/RvddkfdjdfskasdfnBNd.js"></script>
    <script defer src="https://www.3dpea.com/static/js/inflate.min.js"></script>
    <script defer src="https://www.3dpea.com/common/advancedObjects${minFile}.js"></script>
    <script defer src="https://www.3dpea.com/static/js/utils.js"></script>
    <script defer src="https://www.3dpea.com/libs/fonts/js/opentype.min.js"></script>
    <script defer src="https://statics.3dpea.com/common/Loader4Con.min.js?v=0.1"></script>
	<script defer src="/static/js/pea.jewel_${minFile}.js?v=${jsVersion}"></script>
	<script defer src="https://www.3dpea.com/static/js/component.js?v=${jsVersion}"></script>
	<script defer src="./js/exporter${minFile}.js?v=${jsVersion}"></script>
	<script defer src="./js/imageObject${minFile}.js?v=${jsVersion}"></script>
	<script defer src="./js/ASLoader${minFile}.js?v=${jsVersion}"></script>
	<script defer src="./js/index${minFile}.js?v=${jsVersion}"></script>
`);