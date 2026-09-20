import type {CandidateView} from './api';

type Field = CandidateView['diff']['fields'][number];

// Renders the field-by-field difference between the old node and a candidate
// new node. This is the evidence the reviewer uses before confirming.
export function DiffView({diff}: {diff: CandidateView['diff']}) {
  if (diff.fields.length === 0) {
    return <div className="diff identical">No field differences (identical fingerprint).</div>;
  }
  return (
    <table className="diff">
      <thead>
        <tr><th>Signal</th><th>Old node</th><th></th><th>Candidate</th></tr>
      </thead>
      <tbody>
        {diff.fields.map((field, i) => <DiffRow key={i} field={field}/>)}
      </tbody>
      <tfoot>
        <tr><td colSpan={4}>
          structural similarity {(diff.shapeSimilarity * 100).toFixed(0)}%
        </td></tr>
      </tfoot>
    </table>
  );
}

function DiffRow({field}: {field: Field}) {
  switch (field.field) {
    case 'tag':
      return <Row signal="tag" old={field.old} neu={field.new}/>;
    case 'stableAttribute':
      return <Row signal={field.name} old={field.old ?? '—'} neu={field.new ?? '—'}/>;
    case 'class':
      return (
        <tr>
          <td>class</td>
          <td className="old">{field.removed.map(c => <span key={c} className="token del">−{c}</span>)}</td>
          <td>→</td>
          <td className="new">{field.added.map(c => <span key={c} className="token add">+{c}</span>)}</td>
        </tr>
      );
    case 'text':
      return (
        <tr>
          <td>text {(field.similarity * 100).toFixed(0)}%</td>
          <td className="old">{field.old || <em>empty</em>}</td>
          <td>→</td>
          <td className="new">{field.new || <em>empty</em>}</td>
        </tr>
      );
    case 'shape':
      return (
        <tr>
          <td>shape {(field.similarity * 100).toFixed(0)}%</td>
          <td className="old"><code>{field.oldShape.slice(0, 8)}</code></td>
          <td>→</td>
          <td className="new"><code>{field.newShape.slice(0, 8)}</code></td>
        </tr>
      );
    case 'frame':
      return <Row signal="iframe path" old={field.oldPath.join(' › ') || 'top document'} neu={field.newPath.join(' › ') || 'top document'}/>;
    case 'position':
      return <Row signal="index path (diagnostic)" old={`[${field.oldPath.join(',')}]`} neu={`[${field.newPath.join(',')}]`}/>;
    default:
      return null;
  }
}

function Row({signal, old, neu}: {signal: string; old: string; neu: string}) {
  return (
    <tr>
      <td>{signal}</td>
      <td className="old">{old}</td>
      <td>→</td>
      <td className="new">{neu}</td>
    </tr>
  );
}
