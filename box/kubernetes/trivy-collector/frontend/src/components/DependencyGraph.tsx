import { useEffect, useRef, useCallback } from 'react'
import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
import { escapeHtml } from '../utils'
import type { SbomComponent, SbomDependency } from '../types'
import styles from './DependencyGraph.module.css'

cytoscape.use(fcose)

const TYPE_COLORS: Record<string, string> = {
  library: '#3b82f6',
  application: '#22c55e',
  framework: '#f97316',
  'operating-system': '#ef4444',
  device: '#8b5cf6',
  file: '#6b7280',
  container: '#06b6d4',
  firmware: '#ec4899',
  unknown: '#6b7280',
}

interface DependencyGraphProps {
  components: SbomComponent[]
  dependencies: SbomDependency[]
}

export default function DependencyGraph({ components, dependencies }: DependencyGraphProps) {
  const cyRef = useRef<cytoscape.Core | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Pie chart data
  const typeGroups: Record<string, SbomComponent[]> = {}
  components.forEach((comp) => {
    const type = comp.type || comp.component_type || 'unknown'
    if (!typeGroups[type]) typeGroups[type] = []
    typeGroups[type].push(comp)
  })
  const sortedTypes = Object.entries(typeGroups).sort((a, b) => b[1].length - a[1].length)
  const total = components.length

  // Build pie SVG
  const size = 180
  const radius = 70
  const cx = size / 2
  const cy = size / 2
  let currentAngle = -90
  const slices = sortedTypes.map(([type, items]) => {
    const pct = (items.length / total) * 100
    const angle = (pct / 100) * 360
    const color = TYPE_COLORS[type.toLowerCase()] || TYPE_COLORS.unknown
    const startRad = (currentAngle * Math.PI) / 180
    const endRad = ((currentAngle + angle) * Math.PI) / 180
    currentAngle += angle
    const x1 = cx + radius * Math.cos(startRad)
    const y1 = cy + radius * Math.sin(startRad)
    const x2 = cx + radius * Math.cos(endRad)
    const y2 = cy + radius * Math.sin(endRad)
    const largeArc = angle > 180 ? 1 : 0
    const pathD = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`
    return { type, count: items.length, pct, color, pathD }
  })

  const initCytoscape = useCallback(() => {
    if (!containerRef.current || !dependencies.length) return

    const componentMap: Record<string, SbomComponent> = {}
    components.forEach((comp) => {
      const ref = comp['bom-ref'] || comp.bomRef || comp.bom_ref
      if (ref) componentMap[ref] = comp
    })

    const nodes: cytoscape.ElementDefinition[] = []
    const edges: cytoscape.ElementDefinition[] = []
    const nodeIds = new Set<string>()
    const maxNodes = 100
    let nodeCount = 0

    const addNode = (ref: string, depCount = 0) => {
      if (nodeIds.has(ref) || nodeCount >= maxNodes) return
      const comp = componentMap[ref]
      const name = comp?.name || ref.split('/').pop() || ref
      const version = comp?.version || ''
      const type = (comp?.type || comp?.component_type || 'unknown').toLowerCase()
      nodes.push({
        data: {
          id: ref,
          label: version ? `${name}\n${version}` : name,
          name,
          version,
          type,
          color: TYPE_COLORS[type] || TYPE_COLORS.unknown,
          dependencyCount: depCount,
        },
      })
      nodeIds.add(ref)
      nodeCount++
    }

    dependencies.forEach((dep) => {
      if (nodeCount >= maxNodes) return
      addNode(dep.ref, dep.dependsOn?.length || 0)
      dep.dependsOn?.forEach((depRef) => {
        if (nodeCount >= maxNodes) return
        addNode(depRef)
        edges.push({ data: { id: `${dep.ref}->${depRef}`, source: dep.ref, target: depRef } })
      })
    })

    if (nodes.length === 0) return

    if (cyRef.current) cyRef.current.destroy()

    cyRef.current = cytoscape({
      container: containerRef.current,
      elements: [...nodes, ...edges],
      style: [
        { selector: 'node', style: { 'background-color': 'data(color)', label: 'data(label)', color: '#f5f5f5', 'text-valign': 'bottom', 'text-halign': 'center', 'font-size': '10px', 'text-margin-y': 6, width: 30, height: 30, 'text-wrap': 'wrap', 'text-max-width': '80px', 'border-width': 2, 'border-color': '#2a2a2a' } },
        { selector: 'node:selected', style: { 'border-color': '#f97316', 'border-width': 3 } },
        { selector: 'edge', style: { width: 1.5, 'line-color': '#555', 'target-arrow-color': '#555', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.8 } },
        { selector: 'edge:selected', style: { 'line-color': '#f97316', 'target-arrow-color': '#f97316' } },
      ],
      layout: { name: 'fcose', quality: 'proof', randomize: true, animate: false, fit: true, padding: 30, nodeRepulsion: 8000, idealEdgeLength: 80, edgeElasticity: 0.45, numIter: 2500 } as cytoscape.LayoutOptions,
      minZoom: 0.1,
      maxZoom: 3,
    })

    cyRef.current.on('mouseover', 'node', (event) => {
      const node = event.target
      const d = node.data()
      node.style('border-color', '#f97316')
      if (containerRef.current) containerRef.current.title = `${d.name} ${d.version ? 'v' + d.version : ''}\nType: ${d.type}\nDependencies: ${d.dependencyCount}`
    })
    cyRef.current.on('mouseout', 'node', (event) => {
      const node = event.target
      if (!node.selected()) node.style('border-color', '#2a2a2a')
      if (containerRef.current) containerRef.current.title = ''
    })
  }, [components, dependencies])

  useEffect(() => {
    initCytoscape()
    return () => { cyRef.current?.destroy() }
  }, [initCytoscape])

  const handleZoomIn = () => { cyRef.current?.zoom(cyRef.current.zoom() * 1.2); cyRef.current?.center() }
  const handleZoomOut = () => { cyRef.current?.zoom(cyRef.current.zoom() / 1.2); cyRef.current?.center() }
  const handleFit = () => { cyRef.current?.fit() }
  const handleSave = () => {
    if (!cyRef.current) return
    const png = cyRef.current.png({ full: true, scale: 2, bg: '#161616' })
    const link = document.createElement('a')
    link.href = png
    link.download = 'dependency-graph.png'
    link.click()
  }

  return (
    <div className={styles.container}>
      <div className="graph-section">
        <div className="section-bar">
          <h3 className="graph-title">Component Distribution</h3>
        </div>
        <div className="section-content">
          <div className={styles.dependencyGraph}>
            <div className={styles.pieContainer}>
              <svg className={styles.pieChart} viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
                {slices.map((s) => (
                  <path key={s.type} d={s.pathD} fill={s.color} className={styles.pieSlice} />
                ))}
                <circle cx={cx} cy={cy} r={40} fill="var(--bg-secondary)" />
                <text x={cx} y={cy - 6} textAnchor="middle" className={styles.pieTotalCount}>{total}</text>
                <text x={cx} y={cy + 10} textAnchor="middle" className={styles.pieTotalLabel}>Total</text>
              </svg>
              <div className={styles.pieLegend}>
                {slices.map((s) => (
                  <div key={s.type} className={styles.pieLegendItem}>
                    <span className={styles.pieLegendColor} style={{ backgroundColor: s.color }} />
                    <span className={styles.pieLegendLabel}>{escapeHtml(s.type)}</span>
                    <span className={styles.pieLegendValue}>{s.count} ({s.pct.toFixed(1)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {dependencies.length > 0 && (
        <div className="graph-section">
          <div className="section-bar">
            <h3 className="graph-title">
              Dependency Graph{' '}
              <a href="https://js.cytoscape.org" target="_blank" rel="noopener noreferrer" className={styles.poweredBy}>
                Powered by Cytoscape.js
              </a>
            </h3>
            <div className={styles.graphControls}>
              <button className={styles.graphBtn} title="Zoom In" onClick={handleZoomIn}><i className="fa-solid fa-plus" /></button>
              <button className={styles.graphBtn} title="Zoom Out" onClick={handleZoomOut}><i className="fa-solid fa-minus" /></button>
              <button className={styles.graphBtn} title="Fit to View" onClick={handleFit}><i className="fa-solid fa-expand" /></button>
              <button className={styles.graphBtn} title="Save as PNG" onClick={handleSave}><i className="fa-solid fa-camera" /></button>
            </div>
          </div>
          <div className="section-content" style={{ padding: 0 }}>
            <div ref={containerRef} className={styles.cytoscapeContainer} />
          </div>
        </div>
      )}
    </div>
  )
}
