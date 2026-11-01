export function PageHeading({ eyebrow, title, description, extra }: { eyebrow: string; title: string; description: string; extra?: React.ReactNode }) {
  return <header className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{extra && <div className="page-heading-extra">{extra}</div>}</header>;
}
